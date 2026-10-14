/**
 * Runtime HTTP + MCP clients for Miu apps. Web-standard only (fetch), so they
 * run in browsers, Bun, Node, Deno and Workers.
 *
 * Pass the app type to get params/query/body/result types per route
 * (`createClient<typeof app>(url).get("/todos/:id", { params: { id: 1 } })`).
 * Without it the client is loose: any path, explicit result type
 * (`client.get<Todo>("/todos/:id", { params: { id: 1 } })`).
 */

import type { Endpoint, RouteSchema } from "../core/app.ts";

export type { Endpoint, RouteSchema };

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type HeadersOption = HeadersInit | (() => HeadersInit | Promise<HeadersInit>);

export interface ClientOptions {
  /** Default headers, or a function returning them per request (e.g. a fresh token). */
  headers?: HeadersOption;
  /** Custom fetch; pass `(i, init) => app.fetch(new Request(i, init))` to call an app in-process. */
  fetch?: FetchLike;
}

export type QueryValue = string | number | boolean | null | undefined | readonly (string | number | boolean)[];

export interface RequestOptions {
  /** Values for `:name` segments (and `path` / `*` for a trailing wildcard). */
  params?: Record<string, string | number>;
  query?: Record<string, QueryValue>;
  /** Sent as JSON unless it is already a BodyInit (FormData, Blob, string, ...). */
  body?: unknown;
  headers?: HeadersInit;
  signal?: AbortSignal;
}

/** Thrown for non-2xx responses. `problem` holds the parsed problem+json (or JSON/text) body. */
export class ClientError extends Error {
  readonly status: number;
  readonly problem: any;
  readonly response: Response;
  constructor(response: Response, problem: unknown) {
    const p = problem as { detail?: string; title?: string } | undefined;
    const detail = typeof problem === "string" ? problem : (p?.detail ?? p?.title);
    super(`HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    this.name = "ClientError";
    this.status = response.status;
    this.problem = problem;
    this.response = response;
  }
}

/** Replace `:params` and a trailing `*` in a route path. */
export function fillPath(path: string, params: Record<string, string | number> = {}): string {
  return path
    .split("/")
    .map((seg) => {
      if (seg === "*") {
        const v = params.path ?? params["*"];
        if (v === undefined) throw new Error('Missing path param "path" (wildcard)');
        return String(v).split("/").map(encodeURIComponent).join("/");
      }
      if (!seg.startsWith(":")) return seg;
      const name = seg.slice(1);
      const v = params[name];
      if (v === undefined) throw new Error(`Missing path param "${name}" for ${path}`);
      return encodeURIComponent(String(v));
    })
    .join("/");
}

function isBodyInit(v: unknown): v is BodyInit {
  return (
    typeof v === "string" ||
    v instanceof FormData ||
    v instanceof URLSearchParams ||
    v instanceof Blob ||
    v instanceof ArrayBuffer ||
    v instanceof Uint8Array ||
    v instanceof ReadableStream
  );
}

async function resolveHeaders(h: HeadersOption | undefined): Promise<Headers> {
  return new Headers(typeof h === "function" ? await h() : h);
}

async function parse(res: Response): Promise<unknown> {
  if (res.status === 204 || res.status === 205) return undefined;
  const text = await res.text();
  if (!text) return undefined;
  if ((res.headers.get("content-type") ?? "").includes("json")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
type Shortcut = <T = any>(path: string, opts?: RequestOptions) => Promise<T>;

export interface Client {
  request<T = any>(method: Method | (string & {}), path: string, opts?: RequestOptions): Promise<T>;
  get: Shortcut;
  post: Shortcut;
  put: Shortcut;
  patch: Shortcut;
  delete: Shortcut;
}

// ---------------------------------------------------------------- typed client

/** Route table of an app type (`typeof app`), or a route table given directly. */
export type RoutesOf<App> = App extends { "~routes": infer R } ? R : App;

type Base = Omit<RequestOptions, "params" | "query" | "body">;

/** Paths that answer `M` (a route registered for `M`, or with `app.all()`). */
export type PathsFor<R, M extends string> = {
  [K in keyof R]: M extends keyof R[K] ? K : "ALL" extends keyof R[K] ? K : never;
}[keyof R] &
  string;

/** The endpoint for method `M` on path `P` (falling back to an `ALL` route). */
export type EndpointFor<R, P extends keyof R, M extends string> = M extends keyof R[P]
  ? R[P][M]
  : "ALL" extends keyof R[P]
    ? R[P]["ALL"]
    : never;

type ParamsOpt<P> = [keyof P] extends [never] ? { params?: never } : {} extends P ? { params?: P } : { params: P };
type QueryOpt<Q> = {} extends Q ? { query?: Q } : { query: Q };
type BodyOpt<B> = undefined extends B
  ? { body?: B | BodyInit }
  : {} extends B
    ? { body?: B | FormData }
    : { body: B | FormData };

/** Request options for one endpoint: params required when the path has any, query/body typed by their schemas. */
export type TypedRequestOptions<EP> = EP extends Endpoint<infer P, infer Q, infer B, unknown>
  ? Base & ParamsOpt<P> & QueryOpt<Q> & BodyOpt<B>
  : RequestOptions;

/** Options argument: required only when some option is. */
type Args<EP> = {} extends TypedRequestOptions<EP> ? [opts?: TypedRequestOptions<EP>] : [opts: TypedRequestOptions<EP>];
type OutputOf<EP> = EP extends { output: infer O } ? O : unknown;

type TypedShortcut<R, M extends string> = <P extends PathsFor<R, M>>(
  path: P,
  ...opts: Args<EndpointFor<R, P, M>>
) => Promise<OutputOf<EndpointFor<R, P, M>>>;

/** Client typed from an app's route table (`createClient<typeof app>()`). */
export interface TypedClient<R> {
  request<M extends Method, P extends PathsFor<R, M>>(
    method: M,
    path: P,
    ...opts: Args<EndpointFor<R, P, M>>
  ): Promise<OutputOf<EndpointFor<R, P, M>>>;
  get: TypedShortcut<R, "GET">;
  post: TypedShortcut<R, "POST">;
  put: TypedShortcut<R, "PUT">;
  patch: TypedShortcut<R, "PATCH">;
  delete: TypedShortcut<R, "DELETE">;
}

/** `Client` when no app type is given, else `TypedClient` for its routes. */
export type ClientFor<App> = [App] extends [never] ? Client : TypedClient<RoutesOf<App>>;

/**
 * Create an HTTP client for a Miu (or any JSON/problem+json) API.
 * `createClient<typeof app>(url)` types every call from the app's routes.
 */
export function createClient<App = never>(baseUrl: string, opts?: ClientOptions): ClientFor<App>;
export function createClient(baseUrl: string, opts: ClientOptions = {}): Client | TypedClient<any> {
  const doFetch = opts.fetch ?? ((i: RequestInfo | URL, init?: RequestInit) => fetch(i, init));
  const base = baseUrl.replace(/\/+$/, "");

  const request = async <T = any>(method: string, path: string, ro: RequestOptions = {}): Promise<T> => {
    const url = new URL(base + fillPath(path.startsWith("/") ? path : `/${path}`, ro.params));
    for (const [k, v] of Object.entries(ro.query ?? {})) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, String(item));
      else url.searchParams.append(k, String(v));
    }
    const headers = await resolveHeaders(opts.headers);
    new Headers(ro.headers).forEach((v, k) => headers.set(k, v));
    if (!headers.has("accept")) headers.set("accept", "application/json, application/problem+json;q=0.9, */*;q=0.8");
    let body: BodyInit | undefined;
    if (ro.body !== undefined) {
      if (isBodyInit(ro.body)) body = ro.body;
      else {
        body = JSON.stringify(ro.body);
        if (!headers.has("content-type")) headers.set("content-type", "application/json");
      }
    }
    const res = await doFetch(url, { method: method.toUpperCase(), headers, body, signal: ro.signal });
    const data = await parse(res);
    if (!res.ok) throw new ClientError(res, data);
    return data as T;
  };

  const short = (m: string): Shortcut => (path, o) => request(m, path, o);
  return { request, get: short("GET"), post: short("POST"), put: short("PUT"), patch: short("PATCH"), delete: short("DELETE") };
}

// ---------------------------------------------------------------- MCP

export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface McpToolResult {
  content: { type: string; text?: string; [k: string]: unknown }[];
  isError?: boolean;
  structuredContent?: any;
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  serverInfo: { name: string; version: string };
  instructions?: string;
}

/** A JSON-RPC error returned by the MCP server. */
export class McpClientError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "McpClientError";
    this.code = code;
    this.data = data;
  }
}

export interface McpClientOptions extends ClientOptions {
  /** Protocol version requested on initialize. Default `2025-06-18`. */
  protocolVersion?: string;
  clientInfo?: { name: string; version: string };
}

export interface McpClient {
  initialize(): Promise<McpInitializeResult>;
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args?: Record<string, unknown>): Promise<McpToolResult>;
  /** Send any JSON-RPC request and return its `result`. */
  rpc<T = any>(method: string, params?: unknown): Promise<T>;
}

/** Read the JSON-RPC message from a JSON or SSE (`text/event-stream`) response. */
async function readRpc(res: Response): Promise<any> {
  const text = await res.text();
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const events = text.split(/\r?\n\r?\n/);
    for (let i = events.length - 1; i >= 0; i--) {
      const data = events[i]!
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (data) return JSON.parse(data);
    }
    return undefined;
  }
  return text ? JSON.parse(text) : undefined;
}

/** Minimal MCP client (Streamable HTTP transport) — handy for testing agent access. */
export function createMcpClient(url: string, opts: McpClientOptions = {}): McpClient {
  const doFetch = opts.fetch ?? ((i: RequestInfo | URL, init?: RequestInit) => fetch(i, init));
  let id = 0;
  let sessionId: string | undefined;
  let protocolVersion: string | undefined;

  const post = async (message: Record<string, unknown>): Promise<Response> => {
    const headers = await resolveHeaders(opts.headers);
    headers.set("content-type", "application/json");
    headers.set("accept", "application/json, text/event-stream");
    if (sessionId) headers.set("mcp-session-id", sessionId);
    if (protocolVersion) headers.set("mcp-protocol-version", protocolVersion);
    const res = await doFetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", ...message }) });
    sessionId = res.headers.get("mcp-session-id") ?? sessionId;
    return res;
  };

  const rpc = async <T = any>(method: string, params?: unknown): Promise<T> => {
    const res = await post({ id: ++id, method, ...(params === undefined ? {} : { params }) });
    let msg: any;
    try {
      msg = await readRpc(res);
    } catch {
      throw new McpClientError(-32700, `Invalid response from MCP server (HTTP ${res.status})`);
    }
    if (msg?.error) throw new McpClientError(msg.error.code, msg.error.message, msg.error.data);
    if (!res.ok || !msg) throw new McpClientError(-32603, `MCP request failed with HTTP ${res.status}`);
    return msg.result as T;
  };

  return {
    rpc,
    async initialize() {
      const result = await rpc<McpInitializeResult>("initialize", {
        protocolVersion: opts.protocolVersion ?? "2025-06-18",
        capabilities: {},
        clientInfo: opts.clientInfo ?? { name: "miujs-client", version: "0" },
      });
      protocolVersion = result.protocolVersion;
      await post({ method: "notifications/initialized" });
      return result;
    },
    async listTools() {
      return (await rpc<{ tools: McpToolInfo[] }>("tools/list")).tools;
    },
    callTool(name, args = {}) {
      return rpc<McpToolResult>("tools/call", { name, arguments: args });
    },
  };
}
