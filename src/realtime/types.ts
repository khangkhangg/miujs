import type { Context } from "../core/context.ts";

/** Payload of an incoming message: text frames are strings, binary frames ArrayBuffers. */
export type WsMessage = string | ArrayBuffer;
/** Anything a socket can send. */
export type WsSendable = string | ArrayBuffer | ArrayBufferView;

/**
 * Runtime-agnostic server-side WebSocket. `D` is the per-connection data
 * returned by the route's `upgrade` hook.
 */
export interface MiuSocket<D = unknown> {
  /** Unique connection id. */
  readonly id: string;
  /** Per-connection data from `meta.upgrade` (mutable). */
  data: D;
  /** 0 connecting, 1 open, 2 closing, 3 closed. */
  readonly readyState: number;
  send(data: WsSendable): void;
  /** Send a value as JSON text. */
  json(value: unknown): void;
  close(code?: number, reason?: string): void;
  subscribe(topic: string): void;
  unsubscribe(topic: string): void;
  /** Send to every other subscriber of `topic` (not this socket). */
  publish(topic: string, data: WsSendable): void;
  /** Register a callback that runs once the socket closes. Returns an unsubscribe function. */
  onClose(fn: () => void): () => void;
  /** The underlying runtime socket (Bun ServerWebSocket or Workers WebSocket). */
  readonly raw: unknown;
}

export interface WsHandlers<D = unknown> {
  open?(ws: MiuSocket<D>): unknown;
  message?(ws: MiuSocket<D>, data: WsMessage): unknown;
  close?(ws: MiuSocket<D>, code: number, reason: string): unknown;
  /** Called on socket errors and when another handler throws. */
  error?(ws: MiuSocket<D>, err: unknown): unknown;
}

/**
 * A function instead of handlers takes over the upgrade itself, e.g. to
 * forward it to a Durable Object with `roomRoute()`.
 */
export type WsForward = (c: Context<any, any>) => Response | Promise<Response>;
