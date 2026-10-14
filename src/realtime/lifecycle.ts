import type { MiuSocket, WsHandlers, WsMessage, WsSendable } from "./types.ts";

/** Shared socket plumbing: id, data, close listeners and safe handler calls. */
export abstract class BaseSocket<D = unknown> implements MiuSocket<D> {
  readonly id: string = crypto.randomUUID();
  data: D;
  readonly handlers: WsHandlers<D>;
  private closers = new Set<() => void>();

  constructor(handlers: WsHandlers<D>, data: D) {
    this.handlers = handlers;
    this.data = data;
  }

  abstract readonly readyState: number;
  abstract readonly raw: unknown;
  abstract send(data: WsSendable): void;
  abstract close(code?: number, reason?: string): void;
  abstract subscribe(topic: string): void;
  abstract unsubscribe(topic: string): void;
  abstract publish(topic: string, data: WsSendable): void;

  json(value: unknown): void {
    this.send(JSON.stringify(value));
  }

  onClose(fn: () => void): () => void {
    this.closers.add(fn);
    return () => this.closers.delete(fn);
  }

  /** Invoke a handler; exceptions and rejections are routed to `error()`. */
  async run(fn: (h: WsHandlers<D>) => unknown): Promise<void> {
    try {
      await fn(this.handlers);
    } catch (err) {
      this.fail(err);
    }
  }

  fail(err: unknown): void {
    if (!this.handlers.error) return console.error("[miu] WebSocket handler error:", err);
    try {
      void Promise.resolve(this.handlers.error(this, err)).catch((e) => console.error("[miu] WebSocket error handler failed:", e));
    } catch (e) {
      console.error("[miu] WebSocket error handler failed:", e);
    }
  }

  open(): Promise<void> {
    return this.run((h) => h.open?.(this));
  }

  message(data: WsMessage): Promise<void> {
    return this.run((h) => h.message?.(this, data));
  }

  async closed(code: number, reason: string): Promise<void> {
    for (const fn of [...this.closers]) {
      try {
        fn();
      } catch (err) {
        this.fail(err);
      }
    }
    this.closers.clear();
    await this.run((h) => h.close?.(this, code, reason));
  }
}

/** Normalize binary frames to ArrayBuffer. */
export function toMessage(data: unknown): WsMessage {
  if (typeof data === "string" || data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  }
  return String(data);
}
