import { definePlugin, type App, type CloudflareNeeds, type Context } from "miujs";
import { makeClient, type AIClient, type AIOptions } from "./client.ts";

declare module "miujs" {
  interface Context {
    /** Model calls from `@miujs/ai`: generate, stream, object, embed, run, rag. */
    ai: AIClient;
  }
}

/**
 * Adds `ctx.ai`.
 *
 * ```ts
 * miu({ plugins: [ai({ provider: anthropic() })] })                 // ANTHROPIC_API_KEY from env
 * miu({ plugins: [ai({ provider: workersAI(), embeddings: {} })] }) // env.AI on Workers
 * ```
 */
export function ai(opts: AIOptions) {
  let app: App | undefined;
  const { env: _env, log: _log, ...shared } = opts;
  return definePlugin({
    name: "ai",
    setup(a: App) {
      app = a;
    },
    onRequest(ctx: Context) {
      // Built on first use, so routes that never touch ctx.ai pay nothing.
      let client: AIClient | undefined;
      Object.defineProperty(ctx, "ai", {
        configurable: true,
        enumerable: false,
        get: () => (client ??= makeClient(shared, { env: ctx.env, log: ctx.log, ctx, app })),
      });
    },
    inspect() {
      return makeClient(shared, { env: {}, log: undefined as never }).inspect();
    },
    cloudflare(): CloudflareNeeds {
      // Workers AI needs an `[ai]` binding and Vectorize an index binding, but CloudflareNeeds has
      // no field for either yet; declare them by hand in wrangler.toml for now.
      return {};
    },
  });
}
