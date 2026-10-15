import { definePlugin, miu, route, type Context } from "miujs";
import { files, type FilesOptions } from "../src/index.ts";
import { memoryStore } from "../src/memory.ts";

export const SECRET = "test-secret-".padEnd(40, "x");

let job: (ctx: Context) => unknown = () => null;
/** Runs `fn` inside a real request and returns its result. */
export const run = route.post("/t/run", { handler: (ctx) => job(ctx as unknown as Context) as any });
/** Same, but GET (no body is read by the core). */
export const runGet = route.get("/t/run", { handler: (ctx) => job(ctx as unknown as Context) as any });

/** Signs users in from an `x-test-user` header, the way @miujs/auth would set ctx.user. */
export const testAuth = definePlugin({
  name: "test-auth",
  onRequest(ctx: Context) {
    const id = ctx.headers.get("x-test-user");
    if (id) ctx.user = { id, roles: [] };
  },
});

export function makeApp(opts: FilesOptions = {}, appOpts: { dev?: boolean } = {}) {
  const store = opts.store ?? memoryStore();
  const plugin = files({ secret: SECRET, ...opts, store });
  const app = miu({ routes: [run, runGet], plugins: [testAuth, plugin], logLevel: "silent", dev: appOpts.dev ?? true });
  const inCtx = async <T>(fn: (ctx: Context) => T | Promise<T>, init: RequestInit & { env?: Record<string, unknown> } = {}): Promise<T> => {
    let out: any;
    let failed: unknown;
    job = async (ctx) => {
      try {
        out = await fn(ctx);
      } catch (err) {
        failed = err;
      }
      return null;
    };
    const { env, ...rest } = init;
    const req = new Request("http://app.test/t/run", { method: "POST", ...rest });
    await (env ? app.dispatch(req, env, { runtime: "bun" }) : app.fetch(req));
    if (failed) throw failed;
    return out as T;
  };
  /** Request a path (or absolute URL) through the app. */
  const req = (url: string, init: RequestInit = {}, env?: Record<string, unknown>) => {
    const r = new Request(new URL(url, "http://app.test"), init);
    return env ? app.dispatch(r, env, { runtime: "bun" }) : app.fetch(r);
  };
  return { app, store, plugin, inCtx, req };
}

export async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as any).error.code;
}
