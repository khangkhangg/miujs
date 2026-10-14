import type { Middleware, Route } from "../core/app.ts";
import type { AppLike, Context } from "../core/context.ts";
import { problem } from "../core/errors.ts";
import { operationId } from "../ai/shared.ts";
import { devFeatureEnabled } from "./env.ts";
import { errorInfo, isTextual, nonce, randomToken, readLimited, recalledError, redactBody, redactHeaders, redactSearch, safeEqual } from "./shared.ts";
import type { Timing, TimingEntry } from "./timing.ts";
import { inspectorPage } from "./inspector-ui.ts";

export interface InspectorOptions {
  /** Mount path of the UI and API. Default `/__miu`. */
  path?: string;
  /** Ring buffer size (most recent requests kept in memory). Default 200. */
  limit?: number;
  /**
   * Replaces the loopback check (e.g. to allow a LAN IP or a reverse proxy you trust).
   * The token is still required.
   */
  allow?: (c: Context<any, any>) => boolean | Promise<boolean>;
  /** Default: on in development (`isDev(c.env)`). Production always turns it off unless `force` is set. */
  enabled?: boolean;
  /** Serve the inspector even when `NODE_ENV`/`MIU_ENV` is `production`. Never do this on a public host. */
  force?: boolean;
  /** Access token (min 16 chars). Default: random per process, printed to the console on first use. */
  token?: string;
  /** Record request/response bodies (text only, up to `maxBodySize`). Default false: bodies are never touched. */
  captureBodies?: boolean;
  /** Max bytes recorded per body. Default 64 KiB. */
  maxBodySize?: number;
  /** MCP endpoint path, used to label JSON-RPC calls with their tool name. Default `/mcp`. */
  mcpPath?: string;
  /** Extra header/query/body field names to redact. */
  redact?: RegExp;
  /** Where the access URL is printed. Default `console.log`. */
  log?: (line: string) => void;
}

export interface InspectedRequest {
  id: number;
  time: string;
  method: string;
  path: string;
  /** Query string without `?`, secrets redacted. */
  query: string;
  status: number;
  /** Milliseconds from the inspector middleware to the response. */
  duration: number;
  /** Matched route pattern, e.g. `/users/:id`. */
  route?: string;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  requestSize?: number;
  responseSize?: number;
  timing: TimingEntry[];
  error?: { name: string; message: string; stack: string[]; location?: string; cause: { name: string; message: string; location?: string }[] };
  mcp?: { method: string; tool?: string };
  requestBody?: unknown;
  responseBody?: unknown;
  truncated?: boolean;
}

const COOKIE = "miu_inspector";
const TOOL_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const encoder = new TextEncoder();

/**
 * Request inspector at `/__miu`: recent requests (status, timing, headers, errors, MCP tool calls),
 * the route table, and live updates over SSE. Dev-only and locked down:
 *
 * - off unless `isDev(c.env)` (or `enabled: true`), and **never** in production without `force: true`;
 * - only loopback clients (Host + forwarding headers + Origin), or whatever `allow(c)` accepts;
 * - a token printed to the console; `?token=` trades it for an HttpOnly SameSite=Strict cookie;
 * - `Cache-Control: no-store`, `X-Robots-Tag: noindex`, strict CSP.
 *
 * Register it first: `app.use(inspector())`.
 */
export function inspector(opts: InspectorOptions = {}): Middleware {
  const base = (opts.path ?? "/__miu").replace(/\/+$/, "") || "/__miu";
  const limit = Math.max(1, opts.limit ?? 200);
  const maxBody = opts.maxBodySize ?? 64 * 1024;
  const mcpPath = opts.mcpPath ?? "/mcp";
  const log = opts.log ?? ((s: string) => console.log(s));
  if (opts.token !== undefined && opts.token.length < 16) throw new Error("inspector(): token must be at least 16 characters");
  const token = opts.token ?? randomToken();

  const buffer: InspectedRequest[] = [];
  const subscribers = new Set<(event: string, data: unknown) => void>();
  const probes = new WeakSet<Request>();
  let nextId = 1;
  let announced = false;

  const emit = (event: string, data: unknown) => {
    for (const s of subscribers) s(event, data);
  };

  const announce = (c: Context<any, any>) => {
    if (announced) return;
    announced = true;
    const port = c.url.port ? `:${c.url.port}` : "";
    log(`[miu] Request inspector: ${c.url.protocol}//localhost${port}${base}?token=${token}`);
  };

  return async (c, next) => {
    if (probes.has(c.req)) return next();
    if (!devFeatureEnabled(opts, c.env as Record<string, unknown>)) return next();
    announce(c);
    const path = c.url.pathname;
    if (path === base || path.startsWith(`${base}/`)) return serve(c, path.slice(base.length) || "/");
    return record(c, next);
  };

  // ----- recording -----

  async function record(c: Context<any, any>, next: () => Promise<void>): Promise<void> {
    const start = performance.now();
    const req = c.req;
    const type = req.headers.get("content-type");
    const len = numberHeader(req.headers, "content-length");
    // Bodies are only read from a clone, started before the handler so the tee never buffers unboundedly.
    const wantBody = opts.captureBodies && req.body && isTextual(type) && !(len! > maxBody);
    const bodyCopy = wantBody ? readLimited(req.clone().body!, maxBody).catch(() => null) : undefined;
    const isMcp = c.url.pathname === mcpPath && req.method === "POST" && req.body && !(len! > maxBody);
    const mcpCopy = isMcp ? (bodyCopy ?? readLimited(req.clone().body!, maxBody).catch(() => null)) : undefined;

    await next();

    const res = c.res;
    const err = recalledError(c);
    const entry: InspectedRequest = {
      id: nextId++,
      time: new Date().toISOString(),
      method: req.method,
      path: c.url.pathname,
      query: redactSearch(c.url.search, opts.redact),
      status: res?.status ?? 0,
      duration: Math.round((performance.now() - start) * 10) / 10,
      requestHeaders: redactHeaders(req.headers, opts.redact),
      responseHeaders: res ? redactHeaders(res.headers, opts.redact) : {},
      timing: [...((c.get("timing") as Timing | undefined)?.entries ?? [])].map((e) => ({ ...e })),
    };
    const route = matchRoute(c.app, req.method, c.url.pathname);
    if (route) entry.route = route;
    if (len !== undefined) entry.requestSize = len;
    const resLen = res ? numberHeader(res.headers, "content-length") : undefined;
    if (resLen !== undefined) entry.responseSize = resLen;
    if (err !== undefined) {
      const info = errorInfo(err);
      entry.error = {
        name: info.name,
        message: info.message,
        stack: info.stack,
        ...(info.location ? { location: info.location } : {}),
        cause: info.cause.map((x) => ({ name: x.name, message: x.message, ...(x.location ? { location: x.location } : {}) })),
      };
    }
    if (mcpCopy) {
      const got = await mcpCopy;
      if (got && !got.truncated) {
        try {
          const msg = JSON.parse(got.text) as { method?: unknown; params?: { name?: unknown } };
          if (msg && typeof msg.method === "string") {
            entry.mcp = { method: msg.method };
            if (msg.method === "tools/call" && typeof msg.params?.name === "string") entry.mcp.tool = msg.params.name;
          }
        } catch {
          // not JSON-RPC
        }
      }
    }

    push(entry);

    // Bodies finish in the background: never delay the response, never wait on a streaming body.
    if (opts.captureBodies) {
      const resType = res?.headers.get("content-type") ?? null;
      const resCopy = res && res.body && isTextual(resType) ? cloneResponse(c) : undefined;
      const work = (async () => {
        const [reqBody, resBody] = await Promise.all([bodyCopy, resCopy ? readLimited(resCopy, maxBody).catch(() => null) : undefined]);
        if (reqBody) {
          entry.requestBody = redactBody(reqBody.text, type, opts.redact);
          entry.requestSize ??= reqBody.truncated ? undefined : reqBody.size;
          if (reqBody.truncated) entry.truncated = true;
        }
        if (resBody) {
          entry.responseBody = redactBody(resBody.text, resType, opts.redact);
          entry.responseSize ??= resBody.truncated ? undefined : resBody.size;
          if (resBody.truncated) entry.truncated = true;
        }
        if (reqBody || resBody) emit("update", entry);
      })().catch(() => {});
      c.executionCtx?.waitUntil(work);
    }
  }

  function push(entry: InspectedRequest) {
    buffer.push(entry);
    if (buffer.length > limit) buffer.splice(0, buffer.length - limit);
    emit("request", entry);
  }

  // ----- serving the UI / API -----

  async function serve(c: Context<any, any>, sub: string): Promise<Response> {
    const allowed = opts.allow ? await opts.allow(c) : isLoopback(c);
    if (!allowed) return problem(404, { detail: `No route for ${c.method} ${c.url.pathname}` });

    const given = c.url.searchParams.get("token");
    if (given !== null) {
      if (!safeEqual(given, token)) return locked(unauthorized());
      const clean = new URL(c.url);
      clean.searchParams.delete("token");
      const secure = c.url.protocol === "https:" ? "; Secure" : "";
      return locked(
        new Response(null, {
          status: 303,
          headers: {
            location: clean.pathname + clean.search,
            "set-cookie": `${COOKIE}=${token}; Path=${base}; HttpOnly; SameSite=Strict${secure}`,
          },
        }),
      );
    }
    const bearer = c.req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    const cookie = c.cookie(COOKIE);
    if (!(cookie && safeEqual(cookie, token)) && !(bearer && safeEqual(bearer, token))) return locked(unauthorized());

    const method = c.method;
    if (sub === "/" || sub === "") {
      if (method !== "GET" && method !== "HEAD") return locked(notAllowed("GET"));
      const n = nonce();
      return locked(
        new Response(inspectorPage({ base, nonce: n }), {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": `default-src 'none'; script-src 'nonce-${n}'; style-src 'nonce-${n}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
          },
        }),
      );
    }
    if (sub === "/events") {
      if (method !== "GET") return locked(notAllowed("GET"));
      return locked(events());
    }
    if (sub === "/api/requests") {
      if (method === "DELETE") {
        buffer.length = 0;
        emit("clear", {});
        return locked(new Response(null, { status: 204 }));
      }
      if (method !== "GET") return locked(notAllowed("GET, DELETE"));
      return locked(Response.json({ limit, requests: [...buffer].reverse() }));
    }
    const one = /^\/api\/requests\/(\d+)$/.exec(sub);
    if (one) {
      const found = buffer.find((r) => r.id === Number(one[1]));
      return locked(found ? Response.json(found) : problem(404, { detail: "Request is no longer in the inspector buffer" }));
    }
    if (sub === "/api/routes") {
      if (method !== "GET") return locked(notAllowed("GET"));
      return locked(Response.json({ app: { name: c.app.config.name, version: c.app.config.version }, routes: routeTable(c.app), links: await links(c) }));
    }
    return locked(problem(404, { detail: `Unknown inspector path ${sub}` }));
  }

  function events(): Response {
    let send: ((event: string, data: unknown) => void) | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      if (send) subscribers.delete(send);
      if (ping) clearInterval(ping);
    };
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        const write = (s: string) => {
          try {
            ctrl.enqueue(encoder.encode(s));
          } catch {
            stop();
          }
        };
        write(": connected\nretry: 2000\n\n");
        send = (event, data) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        subscribers.add(send);
        ping = setInterval(() => write(": ping\n\n"), 15_000);
      },
      cancel: stop,
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream; charset=utf-8", connection: "keep-alive", "x-accel-buffering": "no" },
    });
  }

  /** Probe the app (in-process, not recorded) for the AI/docs endpoints worth linking. */
  async function links(c: Context<any, any>): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const probe = async (p: string): Promise<Response | undefined> => {
      const r = new Request(new URL(p, c.url.origin), { headers: { accept: "*/*" } });
      probes.add(r);
      try {
        const res = await c.app.fetch(r, c.env, c.executionCtx);
        await res.body?.cancel().catch(() => {});
        return res;
      } catch {
        return undefined;
      }
    };
    const [openapi, llms, mcpRes] = await Promise.all([probe("/openapi.json"), probe("/llms.txt"), probe(mcpPath)]);
    if (openapi?.ok) out.openapi = "/openapi.json";
    if (llms?.ok) out.llms = "/llms.txt";
    if (mcpRes && mcpRes.status === 405 && (mcpRes.headers.get("allow") ?? "").includes("POST")) out.mcp = mcpPath;
    return out;
  }
}

// ----- helpers -----

function locked(res: Response): Response {
  let r = res;
  try {
    r.headers.set("x-probe", "1");
    r.headers.delete("x-probe");
  } catch {
    r = new Response(res.body, res);
  }
  const h = r.headers;
  h.set("cache-control", "no-store");
  h.set("x-robots-tag", "noindex, nofollow");
  h.set("x-content-type-options", "nosniff");
  h.set("x-frame-options", "DENY");
  h.set("referrer-policy", "no-referrer");
  h.set("cross-origin-resource-policy", "same-origin");
  return r;
}

function unauthorized(): Response {
  return new Response(
    "MiuJS request inspector: open the URL with ?token=… printed in your server console (it is printed once, on the first request after startup).\n",
    { status: 401, headers: { "content-type": "text/plain; charset=utf-8" } },
  );
}

function notAllowed(allow: string): Response {
  return problem(405, { detail: "Method not allowed" }, { allow });
}

function numberHeader(h: Headers, name: string): number | undefined {
  const v = h.get(name);
  if (v === null || !/^\d+$/.test(v.trim())) return undefined;
  return Number(v);
}

function cloneResponse(c: Context<any, any>): ReadableStream<Uint8Array> | undefined {
  try {
    const copy = c.res.clone();
    return copy.body ?? undefined;
  } catch {
    return undefined;
  }
}

const LOOPBACK_HOST = /^(localhost|.+\.localhost|127(?:\.\d{1,3}){3}|\[?::1\]?|\[?::ffff:127(?:\.\d{1,3}){3}\]?)$/i;
const FORWARD_HEADERS = ["x-forwarded-for", "x-real-ip", "cf-connecting-ip", "true-client-ip", "fly-client-ip", "x-client-ip"];

/** Loopback IP literal (v4, v6, v4-mapped), with optional brackets/port. */
export function isLoopbackAddress(value: string): boolean {
  let v = value.trim().replace(/^"|"$/g, "");
  if (v.startsWith("[")) v = v.slice(1, v.indexOf("]") > 0 ? v.indexOf("]") : undefined);
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(v)) v = v.slice(0, v.lastIndexOf(":"));
  return /^127(?:\.\d{1,3}){3}$/.test(v) || v === "::1" || /^::ffff:127(?:\.\d{1,3}){3}$/i.test(v);
}

/**
 * Heuristic, since Web-standard handlers don't see the socket address: the Host must be a loopback
 * name/IP (defeats DNS rebinding), every forwarding header must name a loopback client, and a
 * browser Origin, if sent, must be this same host.
 */
export function isLoopback(c: Context<any, any>): boolean {
  if (!LOOPBACK_HOST.test(c.url.hostname)) return false;
  const h = c.req.headers;
  for (const name of FORWARD_HEADERS) {
    const v = h.get(name);
    if (v !== null && !v.split(",").every(isLoopbackAddress)) return false;
  }
  const fwd = h.get("forwarded");
  if (fwd !== null) {
    const fors = [...fwd.matchAll(/for=("?\[?[^;,"]*\]?"?)/gi)].map((m) => m[1]!);
    if (!fors.length || !fors.every(isLoopbackAddress)) return false;
  }
  const origin = h.get("origin");
  if (origin !== null) {
    try {
      if (new URL(origin).host !== c.url.host) return false;
    } catch {
      return false;
    }
  }
  const site = h.get("sec-fetch-site");
  if (site === "cross-site") return false;
  return true;
}

// ----- routes -----

export interface RouteRow {
  method: string;
  path: string;
  /** MCP tool name, or null when the route is not exposed as a tool. */
  tool: string | null;
}

export function routeTable(app: AppLike): RouteRow[] {
  return (app.routes as Route[]).map((r) => {
    let tool: string | null = null;
    if (r.meta.tool !== false && TOOL_METHODS.has(r.method)) {
      tool = (typeof r.meta.tool === "object" && r.meta.tool.name) || operationId(r);
    }
    return { method: r.method, path: r.path, tool };
  });
}

interface CompiledRoute {
  method: string;
  path: string;
  re: RegExp;
  score: number;
}
const matchers = new WeakMap<AppLike, { count: number; list: CompiledRoute[] }>();

/** Best-effort matched route pattern (static segments beat params beat wildcards, like the router). */
function matchRoute(app: AppLike | undefined, method: string, path: string): string | undefined {
  if (!app) return undefined;
  let m = matchers.get(app);
  if (!m || m.count !== app.routes.length) {
    m = {
      count: app.routes.length,
      list: app.routes.map((r) => {
        let score = 0;
        const src = r.path
          .split("/")
          .map((seg) => {
            if (seg === "*") return ".*";
            if (seg.startsWith(":")) {
              score += 1;
              return "[^/]+";
            }
            score += 3;
            return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          })
          .join("/")
          .replace(/\/\.\*$/, "(?:/.*)?");
        return { method: r.method, path: r.path, re: new RegExp(`^${src}/?$`), score };
      }),
    };
    matchers.set(app, m);
  }
  let best: CompiledRoute | undefined;
  for (const r of m.list) {
    if (r.method !== method && r.method !== "ALL" && !(method === "HEAD" && r.method === "GET")) continue;
    if (r.re.test(path) && (!best || r.score > best.score)) best = r;
  }
  return best?.path;
}
