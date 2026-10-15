import type { Middleware, Route } from "../core/app.ts";
import { setClientIp, type AppLike, type Context } from "../core/context.ts";
import { toJSONSchema, type JSONSchema } from "../core/schema.ts";
import { objectParts, operationId, pathParamNames } from "./shared.ts";

/**
 * Model Context Protocol server (Streamable HTTP transport, JSON responses).
 * Every route becomes a tool; calls go through the full HTTP pipeline, so
 * auth, rate limits and validation apply to agents exactly as to browsers.
 */

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export interface McpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, JSONSchema>; required?: string[] };
  outputSchema?: JSONSchema;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}

interface ToolBinding {
  tool: McpTool;
  route: Route;
  pathParams: string[];
  queryKeys: Set<string>;
  bodyKeys: Set<string> | null;
}

export interface McpOptions {
  /** Endpoint path. Default `/mcp`. */
  path?: string;
  /** Request headers forwarded from the MCP request to tool calls. */
  forwardHeaders?: string[];
  /** Server instructions shown to the model on initialize. */
  instructions?: string;
}

const TOOL_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

function bindings(app: AppLike): ToolBinding[] {
  const out: ToolBinding[] = [];
  for (const route of app.routes as Route[]) {
    const m = route.meta;
    if (m.tool === false || !TOOL_METHODS.has(route.method)) continue;
    const toolOpts = typeof m.tool === "object" ? m.tool : {};
    const properties: Record<string, JSONSchema> = {};
    const required = new Set<string>();

    const pathParams = pathParamNames(route.path);
    const params = objectParts(m.params);
    for (const name of pathParams) {
      const key = name === "path" && route.path.endsWith("*") ? "*" : name;
      properties[name] = params?.properties[key] ?? { type: "string" };
      required.add(name);
    }
    const query = objectParts(m.query);
    const queryKeys = new Set<string>();
    if (query) {
      for (const [k, v] of Object.entries(query.properties)) {
        properties[k] = v;
        queryKeys.add(k);
      }
      for (const r of query.required) required.add(r);
    }
    let bodyKeys: Set<string> | null = null;
    if (m.body) {
      const body = objectParts(m.body);
      if (body) {
        bodyKeys = new Set(Object.keys(body.properties));
        Object.assign(properties, body.properties);
        for (const r of body.required) required.add(r);
      } else {
        properties.body = toJSONSchema(m.body);
        required.add("body");
      }
    }

    const tool: McpTool = {
      name: toolOpts.name ?? operationId(route),
      description: toolOpts.description ?? m.description ?? m.summary ?? `${route.method} ${route.path}`,
      inputSchema: { type: "object", properties, ...(required.size ? { required: [...required] } : {}) },
    };
    if (m.summary && m.description) tool.title = m.summary;
    if (m.response) {
      const os = toJSONSchema(m.response);
      if (os.type === "object") tool.outputSchema = os;
    }
    tool.annotations = {
      readOnlyHint: route.method === "GET",
      destructiveHint: route.method === "DELETE",
      idempotentHint: route.method === "GET" || route.method === "PUT" || route.method === "DELETE",
    };
    out.push({ tool, route, pathParams, queryKeys, bodyKeys });
  }
  return out;
}

export function listTools(app: AppLike): McpTool[] {
  return bindings(app).map((b) => b.tool);
}

type JsonRpcId = string | number | null;
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: any;
}

class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export function mcp(opts: McpOptions = {}): Middleware {
  const path = opts.path ?? "/mcp";
  const forward = (opts.forwardHeaders ?? ["authorization", "cookie", "x-api-key"]).map((h) => h.toLowerCase());
  let cache: { app: AppLike; count: number; tools: ToolBinding[]; listJson?: string } | undefined;
  const getCache = (app: AppLike) => {
    if (!cache || cache.app !== app || cache.count !== app.routes.length) {
      cache = { app, count: app.routes.length, tools: bindings(app) };
    }
    return cache;
  };

  return async (c, next) => {
    if (c.url.pathname !== path) return next();
    if (c.method !== "POST") {
      return c.newResponse(null, 405, { allow: "POST" });
    }
    // CSRF: tool calls replay the caller's cookies, so a hostile page must not be able to post here.
    // MCP clients always send JSON (which browsers only allow cross-site after a CORS preflight), and
    // a cross-site browser request may only proceed with explicit bearer credentials.
    const type = (c.req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (type !== "application/json") {
      return c.json(rpcError(null, -32600, "MCP requests must use Content-Type: application/json"), 415);
    }
    if (c.req.headers.get("sec-fetch-site") === "cross-site" && !c.req.headers.has("authorization")) {
      return c.json(rpcError(null, -32600, "Cross-site MCP requests require an Authorization header"), 403);
    }
    let msg: JsonRpcRequest;
    try {
      msg = (await c.req.json()) as JsonRpcRequest;
    } catch {
      return c.json(rpcError(null, -32700, "Parse error"), 400);
    }
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      return c.json(rpcError((msg as any)?.id ?? null, -32600, "Invalid Request"), 400);
    }
    if (msg.id === undefined) return c.newResponse(null, 202); // notification

    const cached = getCache(c.app);
    if (msg.method === "tools/list") {
      // The tool list only changes when routes do: serialize it once, not on every call.
      cached.listJson ??= JSON.stringify({ tools: cached.tools.map((b) => b.tool) });
      return c.newResponse(`{"jsonrpc":"2.0","id":${JSON.stringify(msg.id)},"result":${cached.listJson}}`, 200, {
        "content-type": "application/json; charset=utf-8",
      });
    }
    try {
      const result = await dispatch(c, msg, cached.tools, forward, opts);
      return c.json({ jsonrpc: "2.0", id: msg.id, result });
    } catch (e) {
      if (e instanceof RpcError) return c.json(rpcError(msg.id, e.code, e.message));
      throw e;
    }
  };
}

function rpcError(id: JsonRpcId, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function dispatch(
  c: Context<any, any>,
  msg: JsonRpcRequest,
  tools: ToolBinding[],
  forward: string[],
  opts: McpOptions,
): Promise<unknown> {
  switch (msg.method) {
    case "initialize": {
      const requested = msg.params?.protocolVersion;
      return {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: c.app.config.name ?? "miu-app", version: c.app.config.version ?? "0.0.0" },
        ...(opts.instructions ? { instructions: opts.instructions } : {}),
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return { tools: tools.map((b) => b.tool) };
    case "tools/call": {
      const name = msg.params?.name;
      const binding = tools.find((b) => b.tool.name === name);
      if (!binding) throw new RpcError(-32602, `Unknown tool: ${name}`);
      return callTool(c, binding, msg.params?.arguments ?? {}, forward);
    }
    default:
      throw new RpcError(-32601, `Method not found: ${msg.method}`);
  }
}

async function callTool(c: Context<any, any>, b: ToolBinding, args: Record<string, unknown>, forward: string[]) {
  const { route } = b;
  const rest: Record<string, unknown> = { ...args };

  let path = route.path;
  for (const name of b.pathParams) {
    const v = rest[name];
    delete rest[name];
    const encoded =
      name === "path" && route.path.endsWith("*")
        ? String(v ?? "").split("/").map(encodeURIComponent).join("/")
        : encodeURIComponent(String(v ?? ""));
    path = name === "path" && route.path.endsWith("*") ? path.replace(/\*$/, encoded) : path.replace(`:${name}`, encoded);
  }

  const url = new URL(path, c.url.origin);
  const sendBody = route.method !== "GET" && route.method !== "DELETE";
  let body: unknown;
  if (route.meta.body && !b.bodyKeys) {
    body = rest.body;
    delete rest.body;
  } else if (b.bodyKeys) {
    body = {};
    for (const k of b.bodyKeys) {
      if (k in rest) {
        (body as Record<string, unknown>)[k] = rest[k];
        delete rest[k];
      }
    }
  }
  // Leftover args: declared query keys go in the URL; for schemaless write routes, into the JSON body.
  for (const [k, v] of Object.entries(rest)) {
    if (sendBody && !route.meta.body && !b.queryKeys.has(k)) {
      body = { ...(body as object), [k]: v };
      continue;
    }
    if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, String(item));
    else if (v !== undefined && v !== null) url.searchParams.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }

  const headers = new Headers({ accept: "application/json" });
  for (const h of forward) {
    const v = c.req.headers.get(h);
    if (v) headers.set(h, v);
  }
  if (body !== undefined && sendBody) headers.set("content-type", "application/json");
  // Trace tool calls under the agent's /mcp request (requestId() reuses an incoming id).
  const rid = (c.get("requestId") as string | undefined) ?? c.req.headers.get("x-request-id");
  if (rid) headers.set("x-request-id", rid);

  const inner = new Request(url, {
    method: route.method,
    headers,
    body: body !== undefined && sendBody ? JSON.stringify(body) : undefined,
  });
  setClientIp(inner, c.ip); // rate limits and logs see the agent, not "unknown"
  const res = await c.app.fetch(inner, c.env, c.executionCtx);

  const text = res.status === 204 ? "" : await res.text();
  let structured: unknown;
  if ((res.headers.get("content-type") ?? "").includes("json") && text) {
    try {
      structured = JSON.parse(text);
    } catch {
      structured = undefined;
    }
  }
  const isError = res.status >= 400;
  const result: Record<string, unknown> = {
    content: [{ type: "text", text: text || (isError ? `HTTP ${res.status}` : "OK") }],
    isError,
  };
  if (!isError && structured && typeof structured === "object" && !Array.isArray(structured)) {
    result.structuredContent = structured;
  }
  return result;
}
