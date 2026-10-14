import type { ErrorHandler } from "../core/app.ts";
import type { Context } from "../core/context.ts";
import { HttpError, STATUS_TEXT, problem } from "../core/errors.ts";
import { devFeatureEnabled } from "./env.ts";
import {
  escapeHtml,
  errorInfo,
  isTextual,
  nonce,
  readLimited,
  redactBody,
  redactHeaders,
  redactSearch,
  redactUrl,
  redactValue,
  rememberError,
  type ErrorInfo,
  type StackFrame,
} from "./shared.ts";

export type EditorLink = "vscode" | "cursor" | "zed" | ((frame: { file: string; line: number; column: number }) => string);

export interface DevErrorsOptions {
  /** Default: on in development (`isDev(c.env)`). Always off in production unless `force` is set. */
  enabled?: boolean;
  /** Allow the detailed page in production. Only for throwaway staging boxes; it exposes stacks and request data. */
  force?: boolean;
  /** Where to print the error with its `file:line:col` (default `console.error`); `false` to stay quiet. */
  log?: ((...args: unknown[]) => void) | false;
  /** Extra header/query/body field names to redact, on top of the built-in secret list. */
  redact?: RegExp;
  /** Turn stack frames into editor links, e.g. `"vscode"` → `vscode://file/<path>:<line>:<col>`. */
  editor?: EditorLink;
  /** Max request body bytes to show when the route didn't parse it. Default 64 KiB. */
  maxBodySize?: number;
}

interface RequestInfo {
  method: string;
  url: string;
  params?: Record<string, unknown>;
  query?: string;
  body?: unknown;
}

/**
 * Error handler with readable errors in development:
 * an HTML page for browsers, problem+json with `stack`/`location`/`cause` for API clients,
 * and a `file:line:col` in the console. In production (or when disabled) it behaves exactly like
 * the default handler: `HttpError` → its own response, anything else → a bare 500.
 *
 * ```ts
 * app.onError(devErrors());
 * ```
 */
export function devErrors(opts: DevErrorsOptions = {}): ErrorHandler<any> {
  const log = opts.log === false ? undefined : (opts.log ?? ((...a: unknown[]) => console.error(...a)));
  const maxBody = opts.maxBodySize ?? 64 * 1024;
  return async (err, c) => {
    rememberError(c, err);
    if (!devFeatureEnabled(opts, c.env as Record<string, unknown>)) return fallback(err, c);

    const status = err instanceof HttpError ? err.status : 500;
    const info = errorInfo(err);
    if (log) {
      const where = info.location ? `\n    → ${info.location}` : "";
      if (status >= 500) log(`[miu] ${status} ${c.method} ${c.url.pathname}${where}\n`, err);
      else log(`[miu] ${status} ${c.method} ${c.url.pathname} ${info.name}: ${info.message}${where}`);
    }

    const base: Record<string, unknown> =
      err instanceof HttpError ? ((await err.toResponse().json()) as Record<string, unknown>) : { type: "about:blank", title: STATUS_TEXT[500], status, detail: info.message };
    const request = await requestInfo(c, opts.redact, maxBody);
    const headers = new Headers(err instanceof HttpError ? err.headers : undefined);
    headers.set("cache-control", "no-store");
    headers.set("x-content-type-options", "nosniff");

    if (wantsHtml(c.req)) {
      const n = nonce();
      headers.set("content-type", "text/html; charset=utf-8");
      headers.set("content-security-policy", `default-src 'none'; style-src 'nonce-${n}'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
      headers.set("referrer-policy", "no-referrer");
      const reqHeaders = redactHeaders(c.req.headers, opts.redact);
      return new Response(renderPage({ status, info, base, request, reqHeaders, nonce: n, editor: opts.editor }), { status, headers });
    }

    const body: Record<string, unknown> = { ...base, name: info.name, stack: info.stack };
    if (info.location) body.location = info.location;
    if (info.cause.length) body.cause = info.cause;
    body.request = request;
    return problem(status, body, headers);
  };
}

/** What the app's built-in handler does: no details leave the server. */
function fallback(err: unknown, c: Context<any, any>): Response {
  if (err instanceof HttpError) return err.toResponse();
  if ((c.app?.config as { logger?: boolean } | undefined)?.logger !== false) console.error("[miu] Unhandled error:", err);
  return problem(500);
}

function wantsHtml(req: Request): boolean {
  const accept = req.headers.get("accept") ?? "";
  return accept.includes("text/html");
}

async function requestInfo(c: Context<any, any>, extra: RegExp | undefined, maxBody: number): Promise<RequestInfo> {
  const out: RequestInfo = { method: c.method, url: redactUrl(c.req.url, extra) };
  if (c.params && Object.keys(c.params).length) out.params = redactValue(c.params, extra) as Record<string, unknown>;
  const q = c.url.search;
  if (q.length > 1) out.query = redactSearch(q, extra);
  if (c.body !== undefined) out.body = redactValue(c.body, extra);
  else {
    // The route didn't parse the body. Read a copy only if nobody consumed it and it's small text.
    const type = c.req.headers.get("content-type");
    const len = Number(c.req.headers.get("content-length") ?? NaN);
    if (c.req.body && !c.req.bodyUsed && isTextual(type) && !(len > maxBody)) {
      try {
        const { text, truncated } = await readLimited(c.req.clone().body!, maxBody);
        if (text) out.body = truncated ? `${text}… (truncated)` : redactBody(text, type, extra);
      } catch {
        // unreadable: skip
      }
    }
  }
  return out;
}

// ----- HTML page -----

function editorHref(editor: EditorLink | undefined, f: StackFrame): string | undefined {
  if (!editor || f.internal || !f.file.startsWith("/")) return undefined;
  if (typeof editor === "function") return editor(f);
  return `${editor}://file${encodeURI(f.file)}:${f.line}:${f.column}`;
}

function frameList(frames: StackFrame[], raw: string[], editor: EditorLink | undefined): string {
  if (!frames.length) return raw.length ? `<pre>${escapeHtml(raw.join("\n"))}</pre>` : "<p class=muted>No stack trace.</p>";
  return `<ol class=frames>${frames
    .map((f) => {
      const loc = `${f.file}:${f.line}:${f.column}`;
      const href = editorHref(editor, f);
      const where = href ? `<a href="${escapeHtml(href)}">${escapeHtml(loc)}</a>` : escapeHtml(loc);
      return `<li class="${f.internal ? "internal" : "app"}"><code class=fn>${escapeHtml(f.fn || "(anonymous)")}</code> <code>${where}</code></li>`;
    })
    .join("")}</ol>`;
}

const json = (v: unknown) => escapeHtml(typeof v === "string" ? v : JSON.stringify(v, null, 2));

function renderPage(p: {
  status: number;
  info: ErrorInfo;
  base: Record<string, unknown>;
  request: RequestInfo;
  reqHeaders: Record<string, string>;
  nonce: string;
  editor?: EditorLink;
}): string {
  const { info, request } = p;
  const extra = Object.entries(p.base).filter(([k]) => !["type", "title", "status", "detail"].includes(k));
  const causes = info.cause
    .map(
      (c, i) =>
        `<section class=cause><h3>Caused by ${i + 1}: ${escapeHtml(c.name)}: ${escapeHtml(c.message)}</h3>${c.location ? `<p><code>${escapeHtml(c.location)}</code></p>` : ""}${
          c.stack.length ? `<pre>${escapeHtml(c.stack.join("\n"))}</pre>` : ""
        }</section>`,
    )
    .join("");
  const rows = Object.entries(p.reqHeaders)
    .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`)
    .join("");
  return `<!doctype html>
<html lang=en>
<head>
<meta charset=utf-8>
<meta name=viewport content="width=device-width, initial-scale=1">
<meta name=robots content="noindex">
<title>${p.status} ${escapeHtml(info.name)}: ${escapeHtml(info.message.slice(0, 80))}</title>
<style nonce="${p.nonce}">
:root{--bg:#fff;--fg:#1b1b1f;--muted:#6b6b76;--card:#f5f5f7;--line:#e2e2e8;--accent:#c4302b;--app:#1b1b1f}
@media (prefers-color-scheme:dark){:root{--bg:#141417;--fg:#ececf1;--muted:#9a9aa6;--card:#1e1e23;--line:#2c2c33;--accent:#ff6b63;--app:#fff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:22px;margin:4px 0 8px;color:var(--accent);word-break:break-word}h2{font-size:15px;margin:28px 0 8px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
h3{font-size:14px;margin:0 0 6px}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;background:var(--accent);color:#fff;font-weight:600;font-size:12px}
.loc{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--card);padding:6px 10px;border-radius:6px;display:inline-block;word-break:break-all}
code,pre{font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
pre{background:var(--card);padding:12px;border-radius:8px;overflow:auto;white-space:pre-wrap;word-break:break-word}
.frames{list-style:none;padding:0;margin:0;background:var(--card);border-radius:8px}
.frames li{padding:6px 12px;border-top:1px solid var(--line);word-break:break-all}.frames li:first-child{border-top:0}
.frames .app .fn{font-weight:700;color:var(--app)}.frames .internal{color:var(--muted)}
a{color:inherit}.muted{color:var(--muted)}
table{border-collapse:collapse;width:100%;background:var(--card);border-radius:8px;overflow:hidden}
th,td{text-align:left;padding:5px 12px;border-top:1px solid var(--line);vertical-align:top;font:12.5px ui-monospace,Menlo,monospace;word-break:break-all}
th{width:28%;color:var(--muted);font-weight:500}
.cause{border-left:3px solid var(--line);padding-left:12px;margin:12px 0}
footer{margin-top:40px;color:var(--muted);font-size:12px}
</style>
</head>
<body>
<main>
<span class=badge>${p.status} ${escapeHtml(STATUS_TEXT[p.status] ?? "Error")}</span>
<h1>${escapeHtml(info.name)}: ${escapeHtml(info.message)}</h1>
${info.location ? `<p class=loc>${escapeHtml(info.location)}</p>` : ""}
${extra.length ? `<h2>Problem details</h2><pre>${json(Object.fromEntries(extra))}</pre>` : ""}
<h2>Stack</h2>
${frameList(info.frames, info.stack, p.editor)}
${causes ? `<h2>Cause chain</h2>${causes}` : ""}
<h2>Request</h2>
<pre>${escapeHtml(request.method)} ${escapeHtml(request.url)}</pre>
${request.params ? `<h3>Route params</h3><pre>${json(request.params)}</pre>` : ""}
${request.query ? `<h3>Query</h3><pre>${escapeHtml(request.query)}</pre>` : ""}
${request.body !== undefined ? `<h3>Body</h3><pre>${json(request.body)}</pre>` : ""}
<h3>Headers</h3>
<table>${rows}</table>
<footer>Shown by <code>devErrors()</code> because this is a development environment. Production clients get a plain problem+json response without stack traces. Secrets (authorization, cookies, API keys, tokens, passwords) are redacted.</footer>
</main>
</body>
</html>`;
}
