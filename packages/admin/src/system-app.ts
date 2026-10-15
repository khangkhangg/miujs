// The built-in "app" entry of the System area: uptime, runtime, memory, routes, MCP tools,
// plugins and a bounded count of recent errors (fed by the admin plugin's onError hook).

import { isMiuError, type App, type ManageSection, type ManageValue } from "miujs";

const MAX_CODES = 50;

/** Error counts per code, most recent first, at most 50 codes kept. */
export class ErrorCounter {
  total = 0;
  private byCode = new Map<string, { count: number; lastAt: number }>();

  record(err: unknown, at: number): void {
    this.total++;
    const code = isMiuError(err) ? err.code : "MIU_E_INTERNAL";
    const prev = this.byCode.get(code);
    // Re-inserting keeps the Map in least-recent-first order, so the oldest code is evicted.
    this.byCode.delete(code);
    this.byCode.set(code, { count: (prev?.count ?? 0) + 1, lastAt: at });
    if (this.byCode.size > MAX_CODES) this.byCode.delete(this.byCode.keys().next().value!);
  }

  rows(): Record<string, ManageValue>[] {
    return [...this.byCode].reverse().map(([code, e]) => ({ code, count: e.count, lastAt: e.lastAt }));
  }
}

const toolName = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);

function heapUsed(): number | null {
  const p = (globalThis as { process?: { memoryUsage?: () => { heapUsed: number } } }).process;
  if (!p || typeof p.memoryUsage !== "function") return null; // Workers: not measurable
  try {
    return p.memoryUsage().heapUsed;
  } catch {
    return null;
  }
}

export function appSection(app: App, o: { startedAt: number; now(): number; errors: ErrorCounter }): ManageSection {
  return {
    id: "overview",
    title: "App",
    description: "Uptime, runtime, routes, MCP tools, plugins and recent errors of this instance.",
    status: () => {
      let info: ReturnType<App["inspect"]> | null = null;
      try {
        info = app.inspect();
      } catch {
        info = null; // e.g. conflicting Cloudflare needs; the routes below still come from app.routes()
      }
      const tools = new Set(info?.mcp?.tools ?? []);
      const routes = info
        ? info.routes.map((r) => ({
            method: r.method,
            path: r.path,
            name: r.name,
            auth: typeof r.auth === "object" && r.auth ? `role: ${([] as string[]).concat((r.auth as { role: string | string[] }).role).join(" | ")}` : String(r.auth),
            mcp: tools.has(toolName(r.name)),
          }))
        : app.routes().map((r) => ({ method: r.method, path: r.path, name: r.name, auth: "?", mcp: false }));
      const heap = heapUsed();
      const plugins = app.plugins.map((p) => {
        const version = (p as { version?: unknown }).version;
        return { name: p.name, version: typeof version === "string" ? version : null, manage: typeof p.manage === "function", inspect: typeof p.inspect === "function" };
      });
      return {
        stats: [
          { label: "Uptime", value: o.now() - o.startedAt, type: "duration", hint: "since this instance started" },
          { label: "Runtime", value: app.runtime },
          { label: "App", value: `${app.name} ${app.version}` },
          { label: "Mode", value: app.dev ? "development" : "production" },
          { label: "Memory (heap)", value: heap, type: "bytes", hint: heap === null ? "not measurable on this runtime" : "heap in use" },
          { label: "Routes", value: routes.length, type: "number" },
          { label: "MCP tools", value: info?.mcp ? info.mcp.tools.length : 0, hint: info?.mcp ? info.mcp.path : "MCP is off" },
          { label: "Plugins", value: plugins.length, type: "number" },
          { label: "Errors", value: o.errors.total, tone: o.errors.total ? "warning" : "good", hint: "errors thrown while handling requests since start" },
        ],
        tables: [
          {
            title: "Routes",
            columns: [
              { key: "method", label: "Method", type: "code" },
              { key: "path", label: "Path", type: "code" },
              { key: "name", label: "Name" },
              { key: "auth", label: "Auth" },
              { key: "mcp", label: "MCP", type: "boolean" },
            ],
            rows: routes,
          },
          {
            title: "Plugins",
            columns: [
              { key: "name", label: "Name" },
              { key: "version", label: "Version" },
              { key: "manage", label: "Managed", type: "boolean" },
              { key: "inspect", label: "Inspect", type: "boolean" },
            ],
            rows: plugins,
          },
          {
            title: "Recent errors",
            columns: [
              { key: "code", label: "Code", type: "code" },
              { key: "count", label: "Count", type: "number" },
              { key: "lastAt", label: "Last seen", type: "date" },
            ],
            rows: o.errors.rows(),
          },
        ],
      };
    },
  };
}
