// HTTP for providers: timeouts, retries on 429/5xx/network errors with backoff that honors
// `retry-after`, errors mapped to MIU_E_AI_*, and secrets scrubbed from anything we surface.

import { isMiuError } from "miujs";
import { aiErrors } from "./errors.ts";
import type { ProviderRuntime } from "./types.ts";

/** Longest `retry-after` we are willing to wait inside a request. */
export const MAX_RETRY_DELAY_MS = 30_000;
const BASE_DELAY_MS = 500;
const MAX_BACKOFF_MS = 8_000;

/** Replaces every occurrence of `secret` in `text`. */
export function redact(text: string, secret?: string): string {
  return secret && secret.length >= 4 ? text.split(secret).join("[redacted]") : text;
}

function retryAfterMs(res: Response): number | undefined {
  const h = res.headers.get("retry-after");
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(h);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

function backoff(attempt: number): number {
  const base = Math.min(MAX_BACKOFF_MS, BASE_DELAY_MS * 2 ** attempt);
  return Math.round(base * (0.75 + Math.random() * 0.25));
}

async function errorMessage(res: Response, secret?: string): Promise<string> {
  let text = "";
  try {
    text = await res.text();
  } catch {}
  let msg = text;
  try {
    const body = JSON.parse(text);
    msg = body?.error?.message ?? body?.message ?? (typeof body?.error === "string" ? body.error : text);
  } catch {}
  return redact(String(msg || res.statusText || "no details").slice(0, 500), secret);
}

const isTimeout = (e: unknown) => e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");

const abortReason = (s: AbortSignal) => s.reason ?? new DOMException("The operation was aborted", "AbortError");

/** Waits out a back-off, but stops (throwing the abort reason) as soon as `signal` aborts. */
async function pause(rt: ProviderRuntime, ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  if (!signal) return rt.sleep(ms);
  if (signal.aborted) throw abortReason(signal);
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => {});
  try {
    await Promise.race([rt.sleep(ms, signal), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  if (signal.aborted) throw abortReason(signal);
}

/**
 * `fetch` with a timeout and retries. Resolves only with an ok response; everything else becomes
 * a MiuError. The timeout covers the time to response headers, so streamed bodies may run longer;
 * `init.signal` stays linked for the whole body, so aborting it also stops a streamed response.
 */
export async function send(rt: ProviderRuntime, provider: string, url: string, init: RequestInit, secret?: string): Promise<Response> {
  const outer = init.signal;
  for (let attempt = 0; ; attempt++) {
    if (outer?.aborted) throw abortReason(outer);
    const last = attempt >= rt.retries;
    // The timeout only covers the wait for headers; the caller's signal also covers the body.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new DOMException("timed out", "TimeoutError")), rt.timeoutMs);
    const signal = outer ? AbortSignal.any([outer, ctrl.signal]) : ctrl.signal;
    let res: Response;
    try {
      res = await rt.fetch(url, { ...init, signal });
    } catch (err) {
      if (outer?.aborted) throw err;
      const timedOut = ctrl.signal.aborted || isTimeout(err);
      if (last) {
        if (timedOut) throw aiErrors.timeout(provider, rt.timeoutMs);
        throw aiErrors.provider(provider, undefined, redact(err instanceof Error ? err.message : String(err), secret));
      }
      await pause(rt, backoff(attempt), outer);
      continue;
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) return res;

    const status = res.status;
    if (status === 429 || status >= 500 || status === 408) {
      const wait = retryAfterMs(res);
      const tooLong = wait !== undefined && wait > MAX_RETRY_DELAY_MS;
      if (!last && !tooLong) {
        await res.body?.cancel().catch(() => {});
        await pause(rt, wait ?? backoff(attempt), outer);
        continue;
      }
      if (status === 429) {
        await res.body?.cancel().catch(() => {});
        throw aiErrors.rateLimited(provider, wait === undefined ? undefined : Math.ceil(wait / 1000));
      }
      throw aiErrors.provider(provider, status, await errorMessage(res, secret));
    }
    if (status === 401 || status === 403) throw aiErrors.auth(provider, status, await errorMessage(res, secret));
    throw aiErrors.badRequest(provider, status, await errorMessage(res, secret));
  }
}

/** Server-sent events from a response body. `event` defaults to "message". */
export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncIterable<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let event = "";
  let data: string[] = [];
  let finished = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        finished = true;
        break;
      }
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          if (data.length) yield { event: event || "message", data: data.join("\n") };
          event = "";
          data = [];
        } else if (line.startsWith(":")) {
          continue;
        } else {
          const i = line.indexOf(":");
          const field = i === -1 ? line : line.slice(0, i);
          const val = i === -1 ? "" : line.slice(i + 1).replace(/^ /, "");
          if (field === "event") event = val;
          else if (field === "data") data.push(val);
        }
      }
    }
    if (data.length) yield { event: event || "message", data: data.join("\n") };
  } finally {
    // Stopped early (the consumer broke out, "[DONE]", or an error): close the connection too.
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Wraps a non-MiuError thrown mid-stream (e.g. a dropped connection) as a provider error. */
export function streamError(provider: string, err: unknown, secret?: string) {
  if (isMiuError(err)) return err;
  return aiErrors.provider(provider, undefined, redact(err instanceof Error ? err.message : String(err), secret));
}
