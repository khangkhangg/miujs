// Node.js adapter: node:http on the outside, the web-standard app on the inside.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { App } from "./app.ts";
import { errors } from "./errors.ts";

/** Counts streamed body bytes and fails the read past `limit` (Node has no server-level cap). */
function capped(stream: ReadableStream<Uint8Array>, limit: number): ReadableStream<Uint8Array> {
  let seen = 0;
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > limit) {
          controller.error(errors.custom({ code: "MIU_E_BODY_TOO_LARGE", status: 413, message: `Request body is larger than ${limit} bytes`, fix: "Send a smaller body, or raise maxBodySize." }));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

function toRequest(req: IncomingMessage, origin: string, limit: number): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) for (const item of v) headers.append(k, item);
    else if (v !== undefined) headers.set(k, v);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(origin + (req.url ?? "/"), {
    method: req.method,
    headers,
    body: hasBody ? capped(Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>, limit) : undefined,
    // Required by Node's fetch when streaming a request body.
    duplex: hasBody ? "half" : undefined,
  } as RequestInit);
}

async function send(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    if (key === "set-cookie") return;
    headers[key] = value;
  });
  const cookies = response.headers.getSetCookie?.() ?? [];
  if (cookies.length) headers["set-cookie"] = cookies;
  res.writeHead(response.status, response.statusText, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
  }
  res.end();
}

export async function serveNode(app: App, opts: { port: number; hostname?: string }) {
  const server = createServer(async (req, res) => {
    const host = req.headers.host ?? `localhost:${opts.port}`;
    try {
      const response = await app.fetch(toRequest(req, `http://${host}`, app.maxRequestBodySize), { remoteAddr: { hostname: req.socket.remoteAddress ?? "" } });
      await send(res, response);
    } catch (err) {
      app.log.error("node adapter failed", { err });
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "MIU_E_INTERNAL", message: "Internal server error" } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(opts.port, opts.hostname, resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port;
  return {
    port,
    url: `http://${opts.hostname ?? "localhost"}:${port}/`,
    stop: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
