import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { AppLike } from "../core/context.ts";
import { bunWebSocket } from "../realtime/bun.ts";
import { NodeWsServer, type NodeWsOptions } from "./node-ws.ts";

export type { NodeWsOptions } from "./node-ws.ts";

export interface NodeServeOptions {
  port?: number;
  hostname?: string;
  /** WebSocket limits for `app.ws()` routes (zero-dependency RFC 6455 server). */
  ws?: NodeWsOptions;
}

export interface NodeServer {
  port: number;
  server: Server;
  /** Publish to every WebSocket on this server subscribed to `topic` (same as `app.publish`). */
  publish(topic: string, data: string | ArrayBuffer | ArrayBufferView): number;
  close(): Promise<void>;
}

/** Convert a Node request into a Web-standard Request. */
export function toRequest(req: IncomingMessage, origin: string): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) for (const item of v) headers.append(k, item);
    else if (v !== undefined) headers.set(k, v);
  }
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(new URL(req.url ?? "/", origin), {
    method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as unknown as ReadableStream) : undefined,
    // Required by Node's fetch implementation for streaming bodies.
    ...(hasBody ? { duplex: "half" } : {}),
  } as RequestInit);
}

/** Write a Web-standard Response to a Node response. */
export async function writeResponse(res: Response, out: ServerResponse): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  res.headers.forEach((v, k) => {
    if (k !== "set-cookie") headers[k] = v;
  });
  const cookies = res.headers.getSetCookie();
  if (cookies.length) headers["set-cookie"] = cookies;
  out.writeHead(res.status, headers);
  if (!res.body) return void out.end();
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!out.write(value)) await new Promise<void>((r) => out.once("drain", () => r()));
    }
  } finally {
    out.end();
  }
}

/** Serve a Miu app with Node's http module. */
export function serve(app: AppLike, opts: NodeServeOptions = {}): Promise<NodeServer> {
  const server = createServer(async (req, out) => {
    try {
      const host = req.headers.host ?? `${opts.hostname ?? "localhost"}`;
      const request = toRequest(req, `http://${host}`);
      if (req.socket.remoteAddress) wss.peers.set(request, req.socket.remoteAddress);
      // Pass the server-like object (as Bun does) so `c.ip` and app.publish work for plain HTTP too.
      const res = await app.fetch(request, wss);
      await writeResponse(res, out);
    } catch (err) {
      console.error("[miu] adapter error:", err);
      if (!out.headersSent) out.writeHead(500);
      out.end();
    }
  });
  // WebSockets: Node emits `upgrade` for requests with an Upgrade header. The
  // request runs through the normal pipeline with `wss` as the 2nd fetch arg
  // (the same shape as Bun's server), so middleware, validation and the
  // route's `upgrade()` hook decide before the handshake completes.
  const wss = new NodeWsServer(bunWebSocket, opts.ws);
  server.on("upgrade", (req: IncomingMessage, socket, head: Buffer) => {
    const host = req.headers.host ?? `${opts.hostname ?? "localhost"}`;
    let request: Request;
    try {
      request = toRequest(req, `http://${host}`);
    } catch {
      return void socket.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
    }
    if (req.socket.remoteAddress) wss.peers.set(request, req.socket.remoteAddress);
    void wss.handle(request, socket, head, (r, s) => app.fetch(r, s));
  });
  return new Promise((resolve) => {
    server.listen(opts.port ?? 3000, opts.hostname, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : (opts.port ?? 3000);
      resolve({
        port,
        server,
        publish: (topic, data) => wss.publish(topic, data),
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
            server.closeAllConnections?.();
            for (const ws of wss.connections) ws.terminate();
          }),
      });
    });
  });
}
export { diskBlobStore, type DiskBlobStoreOptions } from "./node-files.ts";
