import { errors, type Env } from "miujs";
import type { MailTransport, OutgoingMail } from "./mailer.ts";

export interface MemoryTransport extends MailTransport {
  readonly outbox: OutgoingMail[];
  clear(): void;
  /** Resolves once the outbox holds `count` messages (for mail sent in the background). */
  waitFor(count?: number, timeoutMs?: number): Promise<OutgoingMail[]>;
}

/** Keeps every message in `.outbox`. For tests. */
export function memoryTransport(): MemoryTransport {
  const outbox: OutgoingMail[] = [];
  let waiters: { count: number; resolve: (v: OutgoingMail[]) => void }[] = [];
  return {
    kind: "memory",
    outbox,
    async send(m) {
      outbox.push(m);
      const ready = waiters.filter((w) => outbox.length >= w.count);
      waiters = waiters.filter((w) => outbox.length < w.count);
      for (const w of ready) w.resolve([...outbox]);
    },
    clear() {
      outbox.length = 0;
    },
    waitFor(count = 1, timeoutMs = 1000) {
      if (outbox.length >= count) return Promise.resolve([...outbox]);
      return new Promise((resolve, reject) => {
        // The timer is cleared once the wait is satisfied, so it never keeps a finished process alive.
        const w = {
          count,
          resolve: (v: OutgoingMail[]) => {
            clearTimeout(timer);
            resolve(v);
          },
        };
        waiters.push(w);
        const timer = setTimeout(() => {
          if (!waiters.includes(w)) return;
          waiters = waiters.filter((x) => x !== w);
          reject(new Error(`memoryTransport: expected ${count} message${count === 1 ? "" : "s"}, got ${outbox.length} within ${timeoutMs} ms`));
        }, timeoutMs);
      });
    },
    inspect: () => ({ outbox: outbox.length }),
  };
}

export interface ConsoleTransportOptions {
  /** Where the summary goes. Default `console.log`. */
  log?: (line: string) => void;
  /** Messages kept for the dev preview. Default 50. */
  keep?: number;
}

/** Logs each message and keeps the last few for `/_miu/mail`. The dev default; never delivers. */
export function consoleTransport(opts: ConsoleTransportOptions = {}): MailTransport & { readonly outbox: OutgoingMail[] } {
  const log = opts.log ?? ((s: string) => console.log(s));
  const keep = opts.keep ?? 50;
  const outbox: OutgoingMail[] = [];
  return {
    kind: "console",
    outbox,
    async send(m) {
      outbox.push(m);
      if (outbox.length > keep) outbox.splice(0, outbox.length - keep);
      log(`[mail] ${m.id} to ${m.to.join(", ")}: ${m.subject}\n${m.text}\n(preview: /_miu/mail/${m.id})`);
    },
    inspect: () => ({ outbox: outbox.length, keep }),
  };
}

function sendFailed(kind: string, status: number, detail: string) {
  return errors.custom({
    code: "MIU_E_MAIL_SEND_FAILED",
    status: 502,
    message: `${kind} rejected the email (HTTP ${status})${detail ? `: ${detail.slice(0, 300)}` : ""}`,
    fix: "Check the API key, that the sender domain is verified with the provider, and the recipient address.",
  });
}

/** Runs one provider call with a deadline covering the whole exchange (headers and body). */
async function withTimeout<T>(provider: string, timeoutMs: number | undefined, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ms = timeoutMs ?? 30_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException("timed out", "TimeoutError")), ms);
  try {
    return await fn(ctrl.signal);
  } catch (err) {
    if (ctrl.signal.aborted) {
      throw errors.custom({
        code: "MIU_E_MAIL_TIMEOUT",
        status: 504,
        message: `${provider} did not answer within ${ms} ms`,
        fix: "Check the provider's status and your network; raise the transport's timeoutMs if it is just slow. The email may or may not have been sent.",
      });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function readDetail(res: Response): Promise<string> {
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text);
      return typeof j?.message === "string" ? j.message : text;
    } catch {
      return text;
    }
  } catch {
    return "";
  }
}

export interface ResendTransportOptions {
  /** Milliseconds to wait for the provider before failing with MIU_E_MAIL_TIMEOUT. Default 30000. */
  timeoutMs?: number;
  /** API key. Default: `env[apiKeyEnv]`. */
  apiKey?: string;
  /** Env var / secret holding the key. Default `RESEND_API_KEY`. */
  apiKeyEnv?: string;
  /** Injectable for tests. Default: global `fetch`. */
  fetch?: typeof fetch;
  /** Default `https://api.resend.com`. */
  baseUrl?: string;
}

/** Resend (resend.com) over its HTTP API. Works on every runtime, including Workers. */
export function resendTransport(opts: ResendTransportOptions = {}): MailTransport {
  const envName = opts.apiKeyEnv ?? "RESEND_API_KEY";
  const base = (opts.baseUrl ?? "https://api.resend.com").replace(/\/+$/, "");
  return {
    kind: "resend",
    async send(m, env) {
      const key = opts.apiKey ?? (env?.[envName] as string | undefined);
      if (!key) {
        throw errors.config(
          "MIU_E_MAIL_API_KEY_MISSING",
          `No Resend API key (looked for ${envName})`,
          `Set the ${envName} environment variable (on Workers: \`wrangler secret put ${envName}\`), or pass resendTransport({ apiKey }).`,
        );
      }
      const body: Record<string, unknown> = { from: m.from, to: m.to, subject: m.subject };
      if (m.html) body.html = m.html;
      body.text = m.text;
      if (m.replyTo) body.reply_to = m.replyTo;
      if (Object.keys(m.headers).length) body.headers = m.headers;
      return withTimeout("Resend", opts.timeoutMs, async (signal) => {
        const res = await (opts.fetch ?? fetch)(`${base}/emails`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal,
        });
        if (!res.ok) throw sendFailed("Resend", res.status, await readDetail(res));
        const json = (await res.json().catch(() => ({}))) as { id?: unknown };
        return typeof json.id === "string" ? { id: json.id } : {};
      });
    },
    inspect: () => ({ apiKey: opts.apiKey ? "(set)" : `env.${envName}` }),
  };
}

export interface HttpTransportOptions {
  url: string;
  /** Milliseconds to wait for the provider before failing with MIU_E_MAIL_TIMEOUT. Default 30000. */
  timeoutMs?: number;
  /** Static headers, or a function of env (for API keys from secrets). */
  headers?: Record<string, string> | ((env: Env) => Record<string, string>);
  /** Turns the message into the provider's JSON body. */
  map: (message: OutgoingMail) => unknown;
  /** Picks the provider's message id out of the JSON response. */
  id?: (json: unknown) => string | undefined;
  fetch?: typeof fetch;
}

/** Any provider with a JSON HTTP API (Postmark, SendGrid, Mailgun, an internal relay...). */
export function httpTransport(opts: HttpTransportOptions): MailTransport {
  return {
    kind: "http",
    async send(m, env) {
      const extra = typeof opts.headers === "function" ? opts.headers(env) : opts.headers;
      const headers = new Headers(extra);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
      const host = new URL(opts.url).host;
      return withTimeout(host, opts.timeoutMs, async (signal) => {
        const res = await (opts.fetch ?? fetch)(opts.url, { method: "POST", headers, body: JSON.stringify(opts.map(m)), signal });
        if (!res.ok) throw sendFailed(host, res.status, await readDetail(res));
        if (!opts.id) {
          await res.body?.cancel();
          return {};
        }
        const json = await res.json().catch(() => null);
        return { id: opts.id(json) };
      });
    },
    inspect: () => ({ url: opts.url }),
  };
}
