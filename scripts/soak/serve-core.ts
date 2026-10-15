// Cross-runtime soak entry for the bare core app, served with `app.listen()`:
//   bun scripts/soak/serve-core.ts [port]
//   node --expose-gc scripts/soak/serve-core.ts [port]
//   deno run -A --v8-flags=--expose-gc scripts/soak/serve-core.ts [port]
// Debug-only routes (added here, not in the app under test): GET /__soak/mem[?gc=1], GET /__soak/stop.
// Prints `READY <port> <ms since process start>`.
import { detectRuntime, route } from "../../packages/miujs/src/index.ts";
import { createCoreApp } from "./core-app.ts";

declare const Deno: any;
const g = globalThis as any;
const args: string[] = typeof Deno !== "undefined" ? Deno.args : process.argv.slice(2);
const port = Number(args[0] ?? 0);

function gc() {
  if (g.Bun) {
    g.Bun.gc(true);
    g.Bun.gc(true);
  } else if (typeof g.gc === "function") {
    g.gc();
    g.gc();
  }
}

function memory() {
  if (typeof Deno !== "undefined") {
    const m = Deno.memoryUsage();
    return { rss: m.rss, heap: m.heapUsed };
  }
  const m = process.memoryUsage();
  if (g.Bun) {
    // Same metric as serve-bun.ts: JSC live heap.
    return { rss: m.rss, heap: jsc.heapStats().heapSize };
  }
  return { rss: m.rss, heap: m.heapUsed };
}

// bun:jsc only exists on Bun; the split specifier keeps Node/Deno from resolving it.
const jsc = g.Bun ? await import("bun:" + "jsc") : null;
let server: { port: number; stop(): Promise<void> };
const app = createCoreApp([
  route.get("/__soak/mem", {
    mcp: false,
    handler: (ctx) => {
      if (new URL(ctx.req.url).searchParams.has("gc")) gc();
      return { ...memory(), runtime: detectRuntime(), canGc: !!(g.Bun || typeof g.gc === "function") };
    },
  }),
  route.get("/__soak/stop", {
    mcp: false,
    handler: () => {
      setTimeout(async () => {
        await server.stop();
        await app.drain();
        console.error("STOPPED");
      }, 5);
      return "stopping";
    },
  }),
]);

server = await app.listen(port, "127.0.0.1");
console.log(`READY ${server.port} ${Math.round(performance.now())}`);
