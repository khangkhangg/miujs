import type { Context } from "../core/context.ts";
import type { RouteMeta } from "../core/app.ts";
import { HttpError, problem } from "../core/errors.ts";
import { isBunServer, upgradeBun, type BunServerLike } from "./bun.ts";
import { LocalTopics, getWebSocketPair, upgradeWorkers } from "./workers.ts";
import type { WsForward, WsHandlers, WsSendable } from "./types.ts";

export { isBunServer };

/** True for `GET` requests carrying `Upgrade: websocket`. */
export function isUpgradeRequest(req: Request): boolean {
  return req.method === "GET" && (req.headers.get("upgrade") ?? "").toLowerCase() === "websocket";
}

export function upgradeRequired(): Response {
  return problem(426, { title: "Upgrade Required", detail: "This endpoint only accepts WebSocket connections" }, { upgrade: "websocket", connection: "Upgrade" });
}

const registries = new WeakMap<object, LocalTopics>();

interface Publisher {
  publish(topic: string, data: WsSendable): unknown;
}
/**
 * Everything that has upgraded a socket for an app: Bun servers, the Node
 * adapter's server, the Workers in-isolate registry. Recorded at upgrade time,
 * which is the only way a socket can ever subscribe, so `app.publish()` before
 * any upgrade correctly reaches nobody.
 */
const publishers = new WeakMap<object, Set<Publisher>>();

function track(app: object, p: Publisher): void {
  let set = publishers.get(app);
  if (!set) publishers.set(app, (set = new Set()));
  set.add(p);
}

/**
 * App-wide publish to every socket subscribed to `topic` (sender included).
 * Bun: native `server.publish`. Node: in-process. Workers: this isolate only;
 * use `MiuRoom` (Durable Objects) to reach sockets in other isolates.
 * Non-binary, non-string values are sent as JSON.
 */
export function publishTopic(app: object, topic: string, data: unknown): void {
  const set = publishers.get(app);
  if (!set) return;
  const payload: WsSendable =
    typeof data === "string" || data instanceof ArrayBuffer || ArrayBuffer.isView(data) ? (data as WsSendable) : JSON.stringify(data);
  for (const p of set) p.publish(topic, payload);
}

/**
 * Run the route's `upgrade` hook and hand the connection to the runtime:
 * Bun (`server.upgrade`; the Node adapter passes an object of the same
 * shape), Workers (`WebSocketPair`), otherwise 501.
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
    track(c.app, server);
    return res;
  }
  const Pair = getWebSocketPair();
  if (Pair) {
    let registry = registries.get(c.app);
    if (!registry) {
      registries.set(c.app, (registry = new LocalTopics()));
      track(c.app, registry);
    }
    return upgradeWorkers(Pair, handlers, data, registry, headers);
  }
  return problem(501, {
    detail: "No WebSocket runtime: on Node serve the app with serve() from miujs/node (it passes the upgrade backend to fetch); Bun and Cloudflare Workers work natively",
    code: "websocket_unsupported",
  });
}
