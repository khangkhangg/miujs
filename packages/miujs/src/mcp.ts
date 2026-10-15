// Model Context Protocol server over Streamable HTTP (stateless JSON responses).
// Every public route becomes a tool whose input schema is built from the route's
// params, query and body schemas; calling the tool dispatches a real request through the app,
// so auth, validation and plugins behave exactly as they do for HTTP clients.

import type { Context } from "./context.ts";
import { errors } from "./errors.ts";
import { objectProps, type DescribedRoute } from "./openapi.ts";
import type { McpTool } from "./plugin.ts";
import { pathParams } from "./router.ts";
import { validate, type JsonSchema } from "./schema.ts";

export interface McpOptions {
  /** Endpoint path. Default `/mcp`. */
  path?: string;
  /** Text sent to clients on initialize, telling the model how to use this server. */
  instructions?: string;
  /** Filter which routes become tools. Routes with `mcp: false` are always excluded. */
  include?: (route: DescribedRoute) => boolean;
  /** Origins allowed to call the endpoint from a browser, in addition to same-origin. */
  allowedOrigins?: string[];
}

export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

type Location = "params" | "query" | "body" | "bodyWhole";

interface RouteTool {
  tool: { name: string; title?: string; description: string; inputSchema: JsonSchema; outputSchema?: JsonSchema; annotations: Record<string, boolean> };
  route: DescribedRoute;
  where: Record<string, Location>;
}

export function toolName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

const pathArg = (param: string) => (param === "*" ? "wildcard" : param);

export function buildRouteTool(r: DescribedRoute): RouteTool {
  const cfg = r.def.config;
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  const where: Record<string, Location> = {};

  const params = objectProps(cfg.params);
  for (const name of pathParams(r.path)) {
    // An unnamed `*` is not a valid tool property name for MCP clients.
    const arg = pathArg(name);
    properties[arg] = params?.props[name] ?? { type: "string" };
    required.push(arg);
    where[arg] = "params";
  }
  const query = objectProps(cfg.query);
  if (query) {
    for (const [k, s] of Object.entries(query.props)) {
      properties[k] = s;
      if (query.required.includes(k)) required.push(k);
      where[k] = "query";
    }
  }
  if (cfg.body) {
    const body = objectProps(cfg.body);
    const clash = body && Object.keys(body.props).some((k) => k in where);
    if (body && !clash) {
      for (const [k, s] of Object.entries(body.props)) {
        properties[k] = s;
        if (body.required.includes(k)) required.push(k);
        where[k] = "body";
      }
    } else {
      properties.body = cfg.body.json;
      if (!cfg.body.isOptional) required.push("body");
      where.body = "bodyWhole";
    }
  }

  const desc = [cfg.summary, cfg.description].filter(Boolean).join("\n\n") || `${r.method} ${r.path}`;
  const authNote = cfg.auth && cfg.auth !== "optional" ? "\n\nRequires an authenticated user." : "";
  const inputSchema: JsonSchema = { type: "object", properties };
  if (required.length) inputSchema.required = required;
  const tool: RouteTool["tool"] = {
    name: toolName(r.name),
    description: desc + authNote + (cfg.permission ? `\n\nRequires permission: ${cfg.permission}.` : ""),
    inputSchema,
    annotations: {
      readOnlyHint: r.method === "GET" || r.method === "HEAD",
      destructiveHint: r.method === "DELETE",
      idempotentHint: r.method === "GET" || r.method === "HEAD" || r.method === "PUT" || r.method === "DELETE",
      openWorldHint: false,
    },
  };
  if (cfg.summary) tool.title = cfg.summary;
  if (cfg.response && cfg.response.json.type === "object") tool.outputSchema = cfg.response.json;
  return { tool, route: r, where };
}

export interface McpHost {
  name: string;
  version: string;
  tools(): { routeTools: RouteTool[]; pluginTools: McpTool[] };
  dispatch(req: Request, ctx: Context): Promise<Response>;
}

/** MCP `structuredContent` must be a JSON object. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function rpcResult(id: unknown, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, result });
}

function rpcError(id: unknown, code: number, message: string, status = 200): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, { status });
}

async function callRouteTool(t: RouteTool, args: Record<string, unknown>, ctx: Context, host: McpHost) {
  args ??= {};
  const path = t.route.path
    .split("/")
    .map((seg) => {
      if (seg[0] !== ":" && seg[0] !== "*") return seg;
      const v = args[pathArg(seg.slice(1) || "*")];
      if (v === undefined) return seg;
      // Wildcards may span segments: keep their slashes.
      return seg[0] === "*" ? String(v).split("/").map(encodeURIComponent).join("/") : encodeURIComponent(String(v));
    })
    .join("/");
  const search = new URLSearchParams();
  let body: unknown;
  for (const [k, v] of Object.entries(args)) {
    const loc = t.where[k];
    if (loc === "query") {
      if (Array.isArray(v)) for (const item of v) search.append(k, String(item));
      else if (v !== undefined && v !== null) search.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    } else if (loc === "body") {
      ((body ??= {}) as Record<string, unknown>)[k] = v;
    } else if (loc === "bodyWhole") {
      body = v;
    }
  }
  const origin = ctx.url.origin;
  const qs = search.toString();
  const headers = new Headers();
  for (const h of ["authorization", "cookie", "x-request-id"]) {
    const v = ctx.req.headers.get(h);
    if (v) headers.set(h, v);
  }
  // Flattened body properties: send `{}` when none were given so defaults and "required" issues apply.
  // A whole body (`bodyWhole`) is sent only when the caller passed one.
  if (body === undefined && Object.values(t.where).includes("body")) body = {};
  if (body !== undefined) headers.set("content-type", "application/json");
  const req = new Request(origin + path + (qs ? `?${qs}` : ""), {
    method: t.route.method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await host.dispatch(req, ctx);
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  const result: Record<string, unknown> = {
    content: [{ type: "text", text: text || `${res.status} ${res.statusText}` }],
    isError: res.status >= 400,
  };
  if (res.ok && t.tool.outputSchema) {
    // Clients reject a result that declares an outputSchema but doesn't conform, so check it
    // here even in production (where the app skips response validation).
    const check = validate(t.route.def.config.response, parsed);
    if (check.ok && isPlainObject(parsed)) {
      result.structuredContent = parsed;
    } else {
      const issues = check.ok ? [{ path: "", message: "expected a JSON object" }] : check.issues;
      result.isError = true;
      result.content = [{ type: "text", text: JSON.stringify(errors.validation("response", issues).toJSON()) }];
    }
  }
  return result;
}

export function createMcpHandler(host: McpHost, opts: McpOptions) {
  const allowed = new Set(opts.allowedOrigins ?? []);
  return async (ctx: Context): Promise<Response> => {
    const origin = ctx.req.headers.get("origin");
    if (origin && !allowed.has(origin)) {
      // DNS-rebinding protection required by the MCP spec: browsers must be same-origin.
      let sameHost = false;
      try {
        sameHost = new URL(origin).host === ctx.url.host;
      } catch {}
      if (!sameHost) return rpcError(null, -32000, `Origin ${origin} is not allowed`, 403);
    }
    if (ctx.method !== "POST") {
      return new Response(null, { status: 405, headers: { allow: "POST" } });
    }
    let msg: any;
    try {
      msg = await ctx.req.json();
    } catch {
      return rpcError(null, -32700, "Parse error: body must be JSON-RPC 2.0", 400);
    }
    if (Array.isArray(msg)) return rpcError(null, -32600, "Batch requests are not supported", 400);
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      return rpcError(msg?.id, -32600, "Invalid request", 400);
    }
    // Notifications and responses get 202 with no body.
    if (msg.id === undefined || msg.id === null) return new Response(null, { status: 202 });

    const { routeTools, pluginTools } = host.tools();
    switch (msg.method) {
      case "initialize": {
        const requested = msg.params?.protocolVersion;
        const protocolVersion = MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0];
        const result: Record<string, unknown> = {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: host.name, version: host.version },
        };
        if (opts.instructions) result.instructions = opts.instructions;
        return rpcResult(msg.id, result);
      }
      case "ping":
        return rpcResult(msg.id, {});
      case "tools/list":
        return rpcResult(msg.id, {
          tools: [
            ...routeTools.map((t) => t.tool),
            ...pluginTools.map((t) => ({ name: t.name, description: t.description ?? t.name, inputSchema: t.inputSchema, ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}) })),
          ],
        });
      case "tools/call": {
        const name = msg.params?.name;
        const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
        const rt = routeTools.find((t) => t.tool.name === name);
        if (rt) return rpcResult(msg.id, await callRouteTool(rt, args, ctx, host));
        const pt = pluginTools.find((t) => t.name === name);
        if (pt) {
          try {
            const out = await pt.call(args, ctx);
            const text = typeof out === "string" ? out : JSON.stringify(out);
            return rpcResult(msg.id, { content: [{ type: "text", text }], isError: false, ...(isPlainObject(out) ? { structuredContent: out } : {}) });
          } catch (err) {
            return rpcResult(msg.id, { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true });
          }
        }
        return rpcError(msg.id, -32602, `Unknown tool: ${name}. Call tools/list to see available tools.`);
      }
      default:
        return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  };
}
