// Shared pieces for the soak runner: latency histograms, op recording, raw-socket helpers.
import { connect as netConnect, type Socket } from "node:net";

/** Log-linear latency histogram: 1 µs resolution under 1 ms, then ~1% buckets. Mergeable. */
export class Histogram {
  counts = new Map<number, number>();
  n = 0;
  sum = 0;
  max = 0;

  private static key(ms: number): number {
    if (ms < 1) return Math.round(ms * 1000) / 1000;
    const e = Math.floor(Math.log10(ms));
    const step = 10 ** (e - 2);
    return Math.round(ms / step) * step;
  }

  add(ms: number) {
    const k = Histogram.key(ms);
    this.counts.set(k, (this.counts.get(k) ?? 0) + 1);
    this.n++;
    this.sum += ms;
    if (ms > this.max) this.max = ms;
  }

  merge(o: { counts: [number, number][] | Map<number, number>; n: number; sum: number; max: number }) {
    for (const [k, v] of o.counts instanceof Map ? o.counts : new Map(o.counts)) this.counts.set(k, (this.counts.get(k) ?? 0) + v);
    this.n += o.n;
    this.sum += o.sum;
    this.max = Math.max(this.max, o.max);
  }

  pct(p: number): number {
    if (!this.n) return 0;
    const keys = [...this.counts.keys()].sort((a, b) => a - b);
    const want = Math.ceil((p / 100) * this.n);
    let seen = 0;
    for (const k of keys) {
      seen += this.counts.get(k)!;
      if (seen >= want) return k;
    }
    return keys[keys.length - 1];
  }

  toJSON() {
    return { counts: [...this.counts], n: this.n, sum: this.sum, max: this.max };
  }
}

/** Records operations (HTTP requests, WebSocket round trips) by name. */
export class Recorder {
  all = new Histogram();
  ops = new Map<string, Histogram>();
  errors = new Map<string, number>();
  /** Expected non-2xx outcomes the scenario asked for (e.g. 404 after delete) — not errors. */
  expected = new Map<string, number>();
  wsFramesIn = 0;
  wsFramesOut = 0;
  stopped = false;

  ok(op: string, ms: number) {
    this.all.add(ms);
    let h = this.ops.get(op);
    if (!h) this.ops.set(op, (h = new Histogram()));
    h.add(ms);
  }

  err(op: string, why: string) {
    if (this.stopped) return;
    const k = `${op}: ${why}`.slice(0, 160);
    this.errors.set(k, (this.errors.get(k) ?? 0) + 1);
  }

  errorCount() {
    let n = 0;
    for (const v of this.errors.values()) n += v;
    return n;
  }
}

export interface HttpResult {
  status: number;
  text: string;
  json: any;
  headers: Headers;
}

/** A cookie-carrying HTTP client bound to one fake client IP, recording every request. */
export function httpClient(base: string, rec: Recorder, ip: string, defaults: Record<string, string> = {}) {
  const jar = new Map<string, string>();
  const c = {
    ip,
    jar,
    async req(op: string, path: string, init: { method?: string; json?: unknown; form?: Record<string, string>; headers?: Record<string, string>; expect?: number[] } = {}): Promise<HttpResult | null> {
      const headers: Record<string, string> = { "x-soak-ip": c.ip, origin: base, ...defaults, ...init.headers };
      if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
      let body: string | undefined;
      if (init.json !== undefined) {
        body = JSON.stringify(init.json);
        headers["content-type"] = "application/json";
      } else if (init.form) {
        body = new URLSearchParams(init.form).toString();
        headers["content-type"] = "application/x-www-form-urlencoded";
      }
      const t = performance.now();
      try {
        const res = await fetch(base + path, { method: init.method ?? (body ? "POST" : "GET"), headers, body, redirect: "manual" });
        const text = await res.text();
        const ms = performance.now() - t;
        for (const sc of res.headers.getSetCookie()) {
          const [pair] = sc.split(";");
          const i = pair.indexOf("=");
          const v = pair.slice(i + 1);
          if (/max-age=0/i.test(sc) || v === "") jar.delete(pair.slice(0, i));
          else jar.set(pair.slice(0, i), v);
        }
        let json: any;
        if (text && (text[0] === "{" || text[0] === "[")) {
          try {
            json = JSON.parse(text);
          } catch {}
        }
        const okStatus = init.expect ? init.expect.includes(res.status) : res.status < 400;
        if (!okStatus) {
          rec.err(op, `HTTP ${res.status} ${json?.error?.code ?? text.slice(0, 60)}`);
          return { status: res.status, text, json, headers: res.headers };
        }
        rec.ok(op, ms);
        if (res.status >= 400) rec.expected.set(`${op} ${res.status}`, (rec.expected.get(`${op} ${res.status}`) ?? 0) + 1);
        return { status: res.status, text, json, headers: res.headers };
      } catch (e) {
        rec.err(op, e instanceof Error ? e.message : String(e));
        return null;
      }
    },
  };
  return c;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function waitFor(fn: () => boolean, ms: number, step = 5): Promise<boolean> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) return false;
    await sleep(step);
  }
  return true;
}

export const rand = (n: number) => Math.floor(Math.random() * n);

// ---- raw sockets for abrupt-disconnect checks ----

function open(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = netConnect(port, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });
}

/** Sends request headers and part of a body, then destroys the socket mid-request. */
export async function abortMidBody(port: number, method: string, path: string, extraHeaders: Record<string, string> = {}): Promise<void> {
  const s = await open(port);
  const h = Object.entries({ host: `127.0.0.1:${port}`, "content-type": "application/json", "content-length": "100000", origin: `http://127.0.0.1:${port}`, ...extraHeaders })
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join("");
  s.write(`${method} ${path} HTTP/1.1\r\n${h}\r\n{"title":"half a bo`);
  await sleep(5);
  s.destroy();
}

/** Opens a WebSocket by hand, waits for the first server frame, then drops the TCP socket without a close frame. */
export async function abortWebSocket(port: number, path: string): Promise<boolean> {
  const s = await open(port);
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
  let got = "";
  const welcomed = new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), 2000);
    s.on("data", (d) => {
      got += d.toString("latin1");
      // 101 headers, then at least one frame after the blank line.
      const i = got.indexOf("\r\n\r\n");
      if (got.startsWith("HTTP/1.1 101") && i !== -1 && got.length > i + 4) {
        clearTimeout(t);
        resolve(true);
      } else if (i !== -1 && !got.startsWith("HTTP/1.1 101")) {
        clearTimeout(t);
        resolve(false);
      }
    });
  });
  s.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  const ok = await welcomed;
  s.destroy();
  return ok;
}

export const fmtMB = (b: number) => (b / 1048576).toFixed(1);
export const fmtNum = (n: number) => Math.round(n).toLocaleString("en-US");
