import { definePlugin, type App, type CloudflareNeeds, type Context } from "miujs";
import { makeClient, type AIClient, type AIOptions } from "./client.ts";
import type { VectorStore } from "./vectors.ts";

export interface AIPluginOptions extends AIOptions {
  /**
   * Vector stores the app uses. Listing them lets `miu deploy cloudflare` declare their
   * bindings (e.g. `vectorize("DOCS", { indexName: "docs" })`). Optional.
   */
  stores?: VectorStore[];
}

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
export function ai(opts: AIPluginOptions) {
  let app: App | undefined;
  const { env: _env, log: _log, stores = [], ...shared } = opts;
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
      // Workers AI's [ai] binding (chat or embeddings provider) and listed Vectorize indexes.
      const parts = [shared.provider, shared.embeddings?.provider, ...stores].map((x) => x?.cloudflare?.() ?? {});
      const needs: CloudflareNeeds = {};
      const binding = parts.find((n) => n.ai)?.ai;
      if (binding) needs.ai = binding;
      const indexes = parts.flatMap((n) => n.vectorize ?? []);
      if (indexes.length) needs.vectorize = indexes;
      return needs;
    },
  });
}
