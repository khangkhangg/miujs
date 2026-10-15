// Tools for the agent loop: hand-written ones via `tool()`, and the app's own routes via
// `appTools()`, which go through the app's MCP endpoint so the model sees exactly the tools an
// MCP client would, and every call runs with the current user's auth.

import { isMiuError, isSchema, validate, type App, type Context, type Env, type JsonSchema, type Schema } from "miujs";
import { aiErrors } from "./errors.ts";
import type { ToolSpec } from "./types.ts";

export interface ToolContext {
  /** The request being served, when the tool runs inside one. */
  ctx?: Context;
  env: Env;
  signal?: AbortSignal;
}

export interface AITool<A = any> {
  readonly name: string;
  readonly description: string;
  /** A `t` schema (validated before `run`) or a raw JSON schema (passed through). */
  readonly input: Schema<A> | JsonSchema;
  run(args: A, tc: ToolContext): unknown;
}

/** A set of tools resolved per run (e.g. `appTools(app)`, which needs the current request). */
export interface ToolSource {
  readonly kind: "tool-source";
  resolve(scope: { ctx?: Context; env: Env; app?: App }): Promise<AITool[]>;
}

export type ToolInput = AITool | ToolSource;

/** Define a tool the model may call in `ctx.ai.run()`. */
export function tool<A>(def: { name: string; description: string; input: Schema<A>; run(args: A, tc: ToolContext): unknown }): AITool<A>;
export function tool(def: { name: string; description: string; input: JsonSchema; run(args: any, tc: ToolContext): unknown }): AITool<any>;
export function tool(def: AITool): AITool {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(def?.name ?? "")) {
    throw aiErrors.config(`Invalid tool name ${JSON.stringify(def?.name)}`, "Tool names must be 1-64 characters of letters, digits, _ and -.");
  }
  return def;
}

export function isToolSource(v: unknown): v is ToolSource {
  return typeof v === "object" && v !== null && (v as ToolSource).kind === "tool-source";
}

export function specOf(t: AITool): ToolSpec {
  return { name: t.name, description: t.description, inputSchema: isSchema(t.input) ? t.input.json : (t.input as JsonSchema) };
}

const MAX_RESULT_CHARS = 50_000;

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === undefined) return "(no result)";
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Runs one tool call. Never throws: failures become error results the model can read. */
export async function execute(tools: Map<string, AITool>, name: string, args: Record<string, unknown>, tc: ToolContext): Promise<{ content: string; isError: boolean }> {
  const t = tools.get(name);
  if (!t) return { content: `Unknown tool ${JSON.stringify(name)}. Available: ${[...tools.keys()].join(", ")}`, isError: true };
  let input: unknown = args;
  if (isSchema(t.input)) {
    const check = validate(t.input, args);
    if (!check.ok) return { content: `Invalid arguments: ${check.issues.map((i) => `${i.path || "(root)"} ${i.message}`).join("; ")}`, isError: true };
    input = check.value;
  }
  try {
    const out = await t.run(input, tc);
    return { content: stringify(out).slice(0, MAX_RESULT_CHARS), isError: false };
  } catch (err) {
    if (err instanceof ToolError) return { content: err.message.slice(0, MAX_RESULT_CHARS), isError: true };
    if (isMiuError(err)) return { content: JSON.stringify(err.toJSON()), isError: true };
    return { content: err instanceof Error ? err.message : String(err), isError: true };
  }
}

/** Thrown by a tool to return `message` to the model as an error result, verbatim. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export interface AppToolsOptions {
  /** Which tools to expose: tool names, or a predicate. Default: every MCP tool of the app. */
  include?: string[] | ((name: string) => boolean);
  /** Extra headers on tool calls (e.g. `authorization` for a job acting as a service user). */
  headers?: Record<string, string>;
}

const FORWARD = ["authorization", "cookie", "x-request-id"];
const mcpPaths = new WeakMap<App, string | null>();

function mcpPathOf(app: App): string | null {
  if (!mcpPaths.has(app)) mcpPaths.set(app, (app.inspect().mcp?.path as string | undefined) ?? null);
  return mcpPaths.get(app)!;
}

/**
 * The app's own routes as model tools. Uses the MCP tool definitions (names, descriptions,
 * input schemas), and each call dispatches through the app with the current request's
 * `authorization`/`cookie` headers, so auth and permissions apply exactly as over HTTP.
 * Needs `mcp: true` (or MCP options) in `miu()`.
 *
 * ```ts
 * await ctx.ai.run({ prompt, tools: [appTools(app, { include: ["listTodos", "createTodo"] })] });
 * ```
 */
export function appTools(app?: App | AppToolsOptions, opts: AppToolsOptions = {}): ToolSource {
  let fixed: App | undefined;
  if (app && typeof (app as App).dispatch === "function") fixed = app as App;
  else if (app) opts = app as AppToolsOptions;
  const include = opts.include;
  const keep = (n: string) => (include === undefined ? true : Array.isArray(include) ? include.includes(n) : include(n));

  return {
    kind: "tool-source",
    async resolve(scope) {
      const target = fixed ?? scope.app;
      if (!target) throw aiErrors.config("appTools() has no app", "Pass the app, appTools(app), or use it through ctx.ai with the ai() plugin installed.");
      await target.ready();
      const path = mcpPathOf(target);
      if (!path) {
        throw aiErrors.config("appTools() needs the app's MCP tools, but MCP is off", "Turn it on with miu({ mcp: true }) (or MCP options). Routes with `mcp: false` stay hidden from the model too.");
      }
      const ctx = scope.ctx;
      const origin = ctx ? ctx.url.origin : "http://localhost";
      const headers = new Headers({ "content-type": "application/json", accept: "application/json" });
      if (ctx) for (const h of FORWARD) {
        const v = ctx.req.headers.get(h);
        if (v) headers.set(h, v);
      }
      for (const [k, v] of Object.entries(opts.headers ?? {})) headers.set(k, v);
      const env = ctx?.env ?? scope.env;
      const platform = ((ctx as any)?._platform as Parameters<App["dispatch"]>[2] | undefined) ?? { runtime: target.runtime };
      let id = 0;
      const rpc = async (method: string, params?: unknown): Promise<any> => {
        const req = new Request(origin + path, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
        const res = await target.dispatch(req, env, platform);
        const body: any = await res.json().catch(() => ({}));
        if (body.error) throw new ToolError(String(body.error.message ?? `MCP ${method} failed (${res.status})`));
        if (!res.ok) throw new ToolError(`MCP ${method} failed (${res.status})`);
        return body.result;
      };
      const listed = (await rpc("tools/list")).tools as { name: string; description?: string; inputSchema: JsonSchema }[];
      return listed
        .filter((t) => keep(t.name))
        .map((t) => ({
          name: t.name,
          description: t.description ?? t.name,
          input: t.inputSchema,
          async run(args: Record<string, unknown>) {
            const out = await rpc("tools/call", { name: t.name, arguments: args });
            const text = (out?.content ?? []).map((c: any) => c.text ?? "").join("\n");
            if (out?.isError) throw new ToolError(text || "Tool call failed");
            return out?.structuredContent ?? text;
          },
        }));
    },
  };
}
