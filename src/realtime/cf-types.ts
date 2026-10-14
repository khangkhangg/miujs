/**
 * Minimal structural types for the Cloudflare Workers APIs used by the
 * realtime module, so it type-checks without @cloudflare/workers-types.
 */

export interface CfWebSocket {
  readyState?: number;
  accept(): void;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message" | "close" | "error", fn: (e: Event | any) => void): void;
  serializeAttachment?(value: unknown): void;
  deserializeAttachment?(): unknown;
}

export interface WebSocketPairCtor {
  new (): { 0: CfWebSocket; 1: CfWebSocket };
}

export interface DurableObjectId {
  toString(): string;
}

export interface DurableObjectStub {
  fetch(req: Request): Promise<Response>;
}

export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

/** The WebSocket Hibernation subset of `DurableObjectState`. */
export interface DurableObjectState {
  acceptWebSocket(ws: CfWebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): CfWebSocket[];
  getTags?(ws: CfWebSocket): string[];
  readonly id?: DurableObjectId;
  readonly storage?: unknown;
}
