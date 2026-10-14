import type { Context } from "../core/context.ts";
import type { RouteMeta } from "../core/app.ts";
import { HttpError, problem } from "../core/errors.ts";
import { isBunServer, upgradeBun, type BunServerLike } from "./bun.ts";
import { LocalTopics, getWebSocketPair, upgradeWorkers } from "./workers.ts";
import type { WsForward, WsHandlers } from "./types.ts";

export { isBunServer };

/** True for `GET` requests carrying `Upgrade: websocket`. */
export function isUpgradeRequest(req: Request): boolean {
  return req.method === "GET" && (req.headers.get("upgrade") ?? "").toLowerCase() === "websocket";
}

export function upgradeRequired(): Response {
  return problem(426, { title: "Upgrade Required", detail: "This endpoint only accepts WebSocket connections" }, { upgrade: "websocket", connection: "Upgrade" });
}

const registries = new WeakMap<object, LocalTopics>();

/**
 * Run the route's `upgrade` hook and hand the connection to the runtime:
 * Bun (`server.upgrade`), Workers (`WebSocketPair`), otherwise 501.
 */
export async function upgradeWebSocket(
  c: Context<any, any>,
  meta: RouteMeta & { upgrade?: (c: Context<any, any>) => unknown },
  handlers: WsHandlers<any> | WsForward,
  server: BunServerLike | undefined,
): Promise<Response> {
  if (typeof handlers === "function") return handlers(c);
  const data = meta.upgrade ? await meta.upgrade(c) : undefined;
  if (data instanceof Response) return data;
  const headers = c.newResponse(null, 200).headers;
  if (server) {
    const res = upgradeBun(server, c.req, handlers, data, headers);
    if (!res) throw new HttpError(400, "WebSocket upgrade failed");
    return res;
  }
  const Pair = getWebSocketPair();
  if (Pair) {
    let registry = registries.get(c.app);
    if (!registry) registries.set(c.app, (registry = new LocalTopics()));
    return upgradeWorkers(Pair, handlers, data, registry, headers);
  }
  return problem(501, {
    detail: "WebSockets on Node require the ws adapter (not yet available); use Bun or Cloudflare Workers",
    code: "websocket_unsupported",
  });
}
