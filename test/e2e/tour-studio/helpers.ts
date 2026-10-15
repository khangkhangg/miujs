/**
 * Helpers for the Tour Studio end-to-end tests: start the real server in a child process (Bun or Node) on a
 * free port with a temporary DATA_DIR, and talk to it over HTTP only with a tiny cookie-jar client.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodePng } from "../../../examples/tour/png.ts";
import { makePanorama } from "../../../examples/tour/panorama.ts";

export const ROOT = new URL("../../../", import.meta.url).pathname;
export const ADMIN_EMAIL = "admin@example.com";
export const ADMIN_PASSWORD = "admin-password-123";
export const INSPECTOR_TOKEN = "e2e-inspector-token-0123456789";

export interface Server {
  url: string;
  dataDir: string;
  /** Everything the server printed so far (stdout + stderr). */
  output: () => string;
  stop: () => Promise<void>;
}

export interface StartOptions {
  runtime?: "bun" | "node";
  env?: Record<string, string>;
  /** Reuse a data dir (e.g. one seeded beforehand). */
  dataDir?: string;
}

/** Start apps/tour-studio on a free port. Production mode unless `env.MIU_ENV` says otherwise. */
export async function startServer(o: StartOptions = {}): Promise<Server> {
  const runtime = o.runtime ?? "bun";
  const dataDir = o.dataDir ?? mkdtempSync(join(tmpdir(), "tour-studio-e2e-"));
  const ownsDir = !o.dataDir;
  const entry = join(ROOT, "apps/tour-studio", runtime === "bun" ? "server.ts" : "server-node.ts");
  const cmd = runtime === "bun" ? ["bun", entry] : ["node", "--experimental-strip-types", "--no-warnings", entry];
  const proc = Bun.spawn(cmd, {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      PORT: "0",
      DATA_DIR: dataDir,
      MIU_ENV: "production",
      NODE_ENV: "production",
      SESSION_SECRET: "e2e-session-secret-0123456789abcdef-xyz",
      ADMIN_EMAIL,
      ADMIN_PASSWORD,
      SEED_PANORAMA_WIDTH: "1024",
      TRUST_PROXY: "1",
      COOKIE_SECURE: "0",
      INSPECTOR_TOKEN,
      ...o.env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  let out = "";
  // Keep draining both pipes for the server's whole life: a full pipe would block its logger.
  const drain = async (s: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder();
    const reader = s.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
    }
  };
  void drain(proc.stdout);
  void drain(proc.stderr);
  const deadline = Date.now() + 30_000;
  let url = "";
  while (!url) {
    const m = /listening on (http:\/\/[^\s]+)/.exec(out);
    if (m) url = m[1]!;
    else if (proc.exitCode !== null) throw new Error(`server exited (${proc.exitCode}):\n${out}`);
    else if (Date.now() > deadline) {
      proc.kill();
      throw new Error(`server did not start in time:\n${out}`);
    }
    else await Bun.sleep(25);
  }
  return {
    url,
    dataDir,
    output: () => out,
    stop: async () => {
      proc.kill("SIGTERM");
      await Promise.race([proc.exited, Bun.sleep(3000)]);
      if (proc.exitCode === null) proc.kill("SIGKILL");
      if (ownsDir) rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** A minimal browser-like HTTP client: a cookie jar, no automatic redirects. */
export class Client {
  readonly cookies = new Map<string, string>();
  readonly base: string;
  /** Sent with every request (e.g. a per-test X-Forwarded-For to get a separate rate-limit bucket). */
  headers: Record<string, string> = {};
  /** Every Set-Cookie header received, verbatim. */
  readonly setCookies: string[] = [];

  constructor(base: string) {
    this.base = base;
  }

  cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    for (const [k, v] of Object.entries(this.headers)) if (!headers.has(k)) headers.set(k, v);
    if (this.cookies.size && !headers.has("cookie")) headers.set("cookie", this.cookieHeader());
    const res = await fetch(this.base + path, { ...init, headers, redirect: "manual" });
    for (const sc of res.headers.getSetCookie()) {
      this.setCookies.push(sc);
      const [pair, ...attrs] = sc.split(";");
      const eq = pair!.indexOf("=");
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      const maxAge = attrs.map((a) => a.trim().toLowerCase()).find((a) => a.startsWith("max-age="));
      if (!value || maxAge === "max-age=0") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }

  get(path: string, headers: Record<string, string> = {}) {
    return this.fetch(path, { headers });
  }

  /** JSON request the way the editor sends it (same-origin fetch with X-Requested-With). */
  json(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    return this.fetch(path, {
      method,
      headers: {
        accept: "application/json",
        "x-requested-with": "e2e",
        "sec-fetch-site": "same-origin",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  /** An HTML form post from a page on the same origin. */
  form(path: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
    return this.fetch(path, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin", origin: this.base, accept: "text/html", ...headers },
      body: new URLSearchParams(fields).toString(),
    });
  }

  upload(tourId: string, bytes: Uint8Array, fileName = "room.png", type = "image/png", title?: string) {
    const fd = new FormData();
    fd.set("panorama", new File([bytes as Uint8Array<ArrayBuffer>], fileName, { type }));
    return this.fetch(`/api/tours/${tourId}/scenes${title ? `?title=${encodeURIComponent(title)}` : ""}`, {
      method: "POST",
      headers: { "x-requested-with": "e2e", "sec-fetch-site": "same-origin", accept: "application/json" },
      body: fd,
    });
  }
}

let n = 0;
/** A unique email (and X-Forwarded-For) per call, so tests never share accounts or rate-limit buckets. */
export function unique(prefix = "user") {
  n++;
  const id = `${prefix}${Date.now().toString(36)}${n}`;
  return { email: `${id}@example.com`, ip: `10.${(n >> 8) & 255}.${n & 255}.${(Date.now() >> 4) & 255}` };
}

/** Sign up a new creator with JSON and return a logged-in client. */
export async function creator(base: string, name = "Casey Creator") {
  const c = new Client(base);
  const u = unique("creator");
  c.headers["x-forwarded-for"] = u.ip;
  const password = "correct horse battery";
  const res = await c.json("POST", "/signup", { name, email: u.email, password });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${await res.text()}`);
  const { user } = (await res.json()) as { user: { id: string } };
  return { client: c, email: u.email, password, id: user.id };
}

/** Log in the seeded admin and return the client. */
export async function adminClient(base: string) {
  const c = new Client(base);
  c.headers["x-forwarded-for"] = unique("admin").ip;
  const res = await c.json("POST", "/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  if (res.status !== 200) throw new Error(`admin login failed: ${res.status} ${await res.text()}`);
  return c;
}

let pano: Promise<Uint8Array> | undefined;
/** A real 1024x512 equirectangular PNG from the demo generator (cached). */
export const panorama = () => (pano ??= makePanorama({ label: "E2E", color: [80, 120, 200], width: 1024, doors: [{ yaw: 45, label: "> Next" }] }));

let pano2: Promise<Uint8Array> | undefined;
export const panorama2 = () => (pano2 ??= makePanorama({ label: "Second", color: [190, 120, 60], width: 1024 }));

/** A valid PNG that is not 2:1 (1024x1024). */
export async function squarePng(): Promise<Uint8Array> {
  const w = 1024;
  const rgba = new Uint8Array(w * w * 4).fill(200);
  return encodePng(w, w, rgba);
}

export const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
