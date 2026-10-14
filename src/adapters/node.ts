import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { AppLike } from "../core/context.ts";

export interface NodeServeOptions {
  port?: number;
  hostname?: string;
}

export interface NodeServer {
  port: number;
  server: Server;
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
      const res = await app.fetch(toRequest(req, `http://${host}`));
      await writeResponse(res, out);
    } catch (err) {
      console.error("[miu] adapter error:", err);
      if (!out.headersSent) out.writeHead(500);
      out.end();
    }
  });
  return new Promise((resolve) => {
    server.listen(opts.port ?? 3000, opts.hostname, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : (opts.port ?? 3000);
      resolve({
        port,
        server,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
