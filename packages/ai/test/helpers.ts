import { createLogger, type Logger } from "miujs";
import type { ProviderRuntime } from "../src/types.ts";

export interface Recorded {
  url: string;
  method: string;
  headers: Headers;
  body: any;
}

type Reply = Response | ((req: Recorded, n: number) => Response | Promise<Response>);

/** An injected `fetch` that records requests and answers from a script (last reply repeats). */
export function fakeFetch(...replies: Reply[]) {
  const calls: Recorded[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as any, init);
    const text = await req.text();
    let body: any = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {}
    const rec: Recorded = { url: req.url, method: req.method, headers: req.headers, body };
    calls.push(rec);
    const r = replies[Math.min(calls.length - 1, replies.length - 1)];
    const res = typeof r === "function" ? await r(rec, calls.length - 1) : r;
    return res.clone();
  }) as typeof fetch;
  return Object.assign(fn, { calls });
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** A text/event-stream response from `[event, data]` pairs (event may be null). */
export function sse(events: [string | null, unknown][]): Response {
  const body = events.map(([e, d]) => (e ? `event: ${e}\n` : "") + `data: ${typeof d === "string" ? d : JSON.stringify(d)}\n\n`).join("");
  // Split into small chunks so parsers must handle events spanning reads.
  const bytes = new TextEncoder().encode(body);
  const stream = new ReadableStream({
    start(c) {
      for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7));
      c.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

export function captureLogger(level: "debug" | "info" = "debug"): { log: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  return { log: createLogger(level, {}, (l) => lines.push(l)), lines };
}

export function runtime(over: Partial<ProviderRuntime> = {}): ProviderRuntime & { sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    env: {},
    fetch: fakeFetch(json({})),
    log: createLogger("silent"),
    timeoutMs: 5000,
    retries: 2,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    sleeps,
    ...over,
  };
}

export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}
