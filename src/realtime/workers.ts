import { BaseSocket, toMessage } from "./lifecycle.ts";
import type { CfWebSocket, WebSocketPairCtor } from "./cf-types.ts";
import type { WsHandlers, WsSendable } from "./types.ts";

/**
 * In-isolate topic registry for Workers. A Worker isolate only sees its own
 * connections, so cross-connection rooms in production need a Durable Object
 * (see `MiuRoom` in durable-room.ts).
 */
export class LocalTopics {
  private topics = new Map<string, Set<WorkersSocket<any>>>();
  add(topic: string, s: WorkersSocket<any>) {
    let set = this.topics.get(topic);
    if (!set) this.topics.set(topic, (set = new Set()));
    set.add(s);
  }
  remove(topic: string, s: WorkersSocket<any>) {
    const set = this.topics.get(topic);
    if (!set) return;
    set.delete(s);
    if (!set.size) this.topics.delete(topic);
  }
  publish(topic: string, data: WsSendable, except?: WorkersSocket<any>) {
    for (const s of this.topics.get(topic) ?? []) {
      if (s === except) continue;
      try {
        s.send(data);
      } catch {
        // socket already closing
      }
    }
  }
}

export class WorkersSocket<D = unknown> extends BaseSocket<D> {
  readonly ws: CfWebSocket;
  private registry: LocalTopics;
  private subs = new Set<string>();

  constructor(ws: CfWebSocket, handlers: WsHandlers<D>, data: D, registry: LocalTopics) {
    super(handlers, data);
    this.ws = ws;
    this.registry = registry;
    this.onClose(() => {
      for (const t of this.subs) registry.remove(t, this);
      this.subs.clear();
    });
  }
  get raw(): unknown {
    return this.ws;
  }
  get readyState(): number {
    return this.ws.readyState ?? 1;
  }
  send(data: WsSendable): void {
    this.ws.send(data);
  }
  close(code?: number, reason?: string): void {
    this.ws.close(code, reason);
  }
  subscribe(topic: string): void {
    this.subs.add(topic);
    this.registry.add(topic, this);
  }
  unsubscribe(topic: string): void {
    this.subs.delete(topic);
    this.registry.remove(topic, this);
  }
  publish(topic: string, data: WsSendable): void {
    this.registry.publish(topic, data, this);
  }
}

export function getWebSocketPair(): WebSocketPairCtor | undefined {
  return (globalThis as { WebSocketPair?: WebSocketPairCtor }).WebSocketPair;
}

/** Upgrade with `WebSocketPair` (Cloudflare Workers, Deno Deploy-compatible shims). */
export function upgradeWorkers(
  Pair: WebSocketPairCtor,
  handlers: WsHandlers<any>,
  data: unknown,
  registry: LocalTopics,
  headers: Headers,
): Response {
  const pair = new Pair();
  const client = pair[0];
  const server = pair[1];
  server.accept();
  const socket = new WorkersSocket(server, handlers, data, registry);
  server.addEventListener("message", (e) => void socket.message(toMessage((e as MessageEvent).data)));
  server.addEventListener("close", (e) => {
    const ev = e as CloseEvent;
    void socket.closed(ev.code, ev.reason);
  });
  server.addEventListener("error", (e) => socket.fail((e as ErrorEvent).error ?? e));
  void socket.open();
  return new Response(null, { status: 101, headers, webSocket: client } as ResponseInit);
}
