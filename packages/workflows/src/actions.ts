import { isSchema, t, type Env, type Infer, type Logger, type Schema } from "miujs";
import type { Mailer } from "./define.ts";
import { workflowErrors } from "./errors.ts";

type MaybePromise<T> = T | Promise<T>;

/** What an action's `run` receives besides its params. */
export interface ActionContext {
  env: Env;
  log: Logger;
  fetch: typeof fetch;
  mailer?: Mailer;
  /** A service another plugin provided (`app.provide`). Throws MIU_E_SERVICE_MISSING. */
  service<T = unknown>(name: string): T;
  run: { id: string; workflow: string };
  /** The workflow input (trigger payload). */
  input: unknown;
}

export interface ActionDef<P = any> {
  readonly kind: "miu.workflow.action";
  readonly name: string;
  readonly description?: string;
  readonly params: Schema<P>;
  /** Step retries for this action unless the spec sets `retries`. Default 3. */
  readonly retries: number;
  readonly run: (params: P, ctx: ActionContext) => MaybePromise<unknown>;
}

/**
 * Register an action JSON workflows can call by name:
 *
 * ```ts
 * const updateRecord = defineAction("update_record", {
 *   params: t.object({ id: t.string(), fields: t.record(t.unknown()) }),
 *   run: async ({ id, fields }, { env }) => { ... },
 * });
 * fromJson(spec, { actions: [updateRecord] });
 * ```
 */
export function defineAction<S extends Schema<any>>(
  name: string,
  config: { description?: string; params: S; retries?: number; run: (params: Infer<S>, ctx: ActionContext) => MaybePromise<unknown> },
): ActionDef<Infer<S>> {
  if (typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(name)) {
    throw workflowErrors.config(`defineAction needs a name like "update_record", got ${JSON.stringify(name)}`, 'Call defineAction("update_record", { params, run }).');
  }
  if (!isSchema(config?.params)) throw workflowErrors.config(`Action "${name}": params must be a t schema`, "Pass `params: t.object({ ... })`.");
  if (typeof config.run !== "function") throw workflowErrors.config(`Action "${name}": run must be a function`, "Pass `run: async (params, ctx) => { ... }`.");
  const retries = config.retries ?? 3;
  if (!Number.isInteger(retries) || retries < 0) throw workflowErrors.config(`Action "${name}": retries must be a whole number >= 0`, "Pass `retries: 3` (or 0).");
  return { kind: "miu.workflow.action", name, description: config.description, params: config.params, retries, run: config.run };
}

function nonRetryable<E extends Error>(e: E): E {
  return Object.assign(e, { retryable: false });
}

// ---------------------------------------------------------------------------------------------
// http: the one action a browser-built workflow can point anywhere, so it refuses internal
// addresses (SSRF), re-checks every redirect hop, and bounds time and response size.

export interface HttpActionOptions {
  /** Allow loopback, private, link-local, metadata and other non-public addresses. Default false. */
  allowPrivateNetwork?: boolean;
  /** Per call, including redirects and reading the body. Default 30 000 ms. */
  timeoutMs?: number;
  /** Largest response body kept (it is journaled as the step output). Default 1 MiB. */
  maxResponseBytes?: number;
  /** Redirect hops followed (each one checked). Default 5. */
  maxRedirects?: number;
}

function ipv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

function privateV4([a, b, c]: number[]): boolean {
  return (
    a === 0 || // "this network", 0.0.0.0
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast, reserved, broadcast
  );
}

/** 8 groups of 16 bits, or null. Accepts a dotted IPv4 tail. */
function ipv6(host: string): number[] | null {
  let h = host;
  const tail = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  if (tail) {
    const v4 = ipv4(tail[1]);
    if (!v4) return null;
    h = h.slice(0, -tail[1].length) + `${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = h.split("::");
  if (halves.length > 2) return null;
  const parse = (s: string) => (s === "" ? [] : s.split(":").map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN)));
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  const groups = [...head, ...Array(Math.max(0, fill)).fill(0), ...rest];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g)) && fill >= 0 ? groups : null;
}

function privateV6(g: number[]): boolean {
  const embedded = (hi: number, lo: number) => privateV4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  if (g.slice(0, 7).every((x) => x === 0)) return true; // :: and ::1
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return embedded(g[6], g[7]); // v4-mapped / -compatible
  if (g[0] === 0x64 && g[1] === 0xff9b) return embedded(g[6], g[7]); // NAT64
  if (g[0] === 0x2002) return embedded(g[1], g[2]); // 6to4
  if ((g[0] & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g[0] & 0xffc0) === 0xfec0) return true; // site-local (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  return false;
}

/** Why `url` must not be fetched, or null. Hostnames are judged by name only (no DNS lookup). */
export function blockedUrlReason(url: URL): string | null {
  if (url.protocol !== "http:" && url.protocol !== "https:") return `scheme ${url.protocol} is not http(s)`;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[")) {
    const g = ipv6(host.slice(1, -1));
    return !g || privateV6(g) ? "it is a loopback, private or link-local IPv6 address" : null;
  }
  const v4 = ipv4(host);
  if (v4) return privateV4(v4) ? "it is a loopback, private, link-local or reserved IPv4 address" : null;
  if (!host.includes(".")) return "single-label hostnames (localhost, intranet names) are internal";
  if (/\.(localhost|local|internal|localdomain|home\.arpa)$/.test(host)) return "the hostname is internal";
  return null;
}

/** For messages and errors: no credentials or query string (they may hold tokens). */
function shown(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

async function readLimited(res: Response, limit: number, url: URL): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await res.body?.cancel().catch(() => {});
    throw nonRetryable(workflowErrors.httpTooLarge(shown(url), limit));
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw nonRetryable(workflowErrors.httpTooLarge(shown(url), limit));
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

const httpParams = t.object({
  url: t.string({ format: "url" }),
  method: t.optional(t.enum(["GET", "POST", "PUT", "PATCH", "DELETE"])),
  headers: t.optional(t.record(t.string())),
  body: t.optional(t.unknown()),
});

/**
 * The `http` action with your limits. Register it to replace the built-in one:
 * `fromJson(spec, { actions: [createHttpAction({ allowPrivateNetwork: true })] })`.
 */
export function createHttpAction(opts: HttpActionOptions = {}): ActionDef<Infer<typeof httpParams>> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxBytes = opts.maxResponseBytes ?? 1024 * 1024;
  const maxRedirects = opts.maxRedirects ?? 5;
  const check = (u: URL) => {
    if (opts.allowPrivateNetwork && (u.protocol === "http:" || u.protocol === "https:")) return;
    const why = blockedUrlReason(u);
    if (why) throw nonRetryable(workflowErrors.httpBlocked(shown(u), why));
  };
  return defineAction("http", {
    description: "Call a public HTTP endpoint. 5xx, 408 and 429 are retried; other non-2xx fail the step. Internal addresses are refused.",
    params: httpParams,
    run: async (p, ctx) => {
      const headers = new Headers(p.headers);
      let body: string | undefined;
      if (p.body !== undefined && p.body !== null) {
        if (typeof p.body === "string") body = p.body;
        else {
          body = JSON.stringify(p.body);
          if (!headers.has("content-type")) headers.set("content-type", "application/json");
        }
      }
      let method: string = p.method ?? (body === undefined ? "GET" : "POST");
      let url = new URL(p.url);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        let res: Response;
        for (let hop = 0; ; hop++) {
          check(url);
          res = await ctx.fetch(url.href, { method, headers, body, redirect: "manual", signal: ctrl.signal });
          const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
          if (location === null) break;
          await res.body?.cancel().catch(() => {});
          if (hop >= maxRedirects) throw nonRetryable(new Error(`Too many redirects from ${shown(new URL(p.url))}`));
          const next = new URL(location, url);
          if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
            method = "GET";
            body = undefined;
            headers.delete("content-type");
          }
          if (next.origin !== url.origin) {
            headers.delete("authorization");
            headers.delete("cookie");
          }
          url = next;
        }
        const text = await readLimited(res, maxBytes, url);
        let parsed: unknown = text;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {}
        if (!res.ok) {
          const err = new Error(`HTTP ${res.status} from ${shown(url)}: ${text.slice(0, 200)}`);
          throw res.status >= 500 || res.status === 408 || res.status === 429 ? err : nonRetryable(err);
        }
        return { status: res.status, body: parsed };
      } catch (err) {
        if (ctrl.signal.aborted) throw workflowErrors.httpTimeout(shown(url), timeoutMs);
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },
  });
}

export const httpAction = createHttpAction();

export const sendEmailAction = defineAction("send_email", {
  description: "Send an email through the configured mailer (workflows({ mailer }) or a plugin named mail).",
  params: t.object({
    to: t.union([t.string(), t.array(t.string())]),
    subject: t.string({ minLength: 1 }),
    text: t.optional(t.string()),
    html: t.optional(t.string()),
    from: t.optional(t.string()),
    replyTo: t.optional(t.string()),
  }),
  run: async (p, ctx) => {
    if (!ctx.mailer) throw nonRetryable(workflowErrors.mailer());
    const result = await ctx.mailer.send(p);
    return { sent: true, ...(result && typeof result === "object" ? { result } : {}) };
  },
});

export const logAction = defineAction("log", {
  description: "Write a line to the app log.",
  params: t.object({ message: t.string(), level: t.optional(t.enum(["debug", "info", "warn", "error"])), data: t.optional(t.unknown()) }),
  retries: 0,
  run: (p, ctx) => {
    ctx.log[p.level ?? "info"](p.message, p.data === undefined ? undefined : { data: p.data });
    return null;
  },
});

export const BUILTIN_ACTIONS: readonly ActionDef[] = [httpAction, sendEmailAction, logAction];

/** For builders: every action with its params JSON schema. */
export function describeActions(actions: readonly ActionDef[] = []): { name: string; description?: string; params: unknown }[] {
  const all = new Map<string, ActionDef>();
  for (const a of [...BUILTIN_ACTIONS, ...actions]) all.set(a.name, a);
  return [...all.values()].map((a) => ({ name: a.name, description: a.description, params: a.params.json }));
}
