// Harness fixture for the batteries the examples don't use on Workers: R2 files with signed URLs,
// a job + cron schedule on Cloudflare Queues whose effect lands in KV, the Rate Limiting binding,
// the Durable Object rate limiter, @miujs/bots with the Cache API store, KV sessions, and a
// Cloudflare Workflows class. Built for `wrangler dev --local` by scripts/workerd/run.ts.

import { WorkflowEntrypoint } from "cloudflare:workers";
import { definePlugin, miu, route, t } from "miujs";
import { bots, cacheApiStore } from "@miujs/bots";
import { files, r2Store } from "@miujs/files";
import { defineJob, queue, schedule } from "@miujs/queue";
import { cloudflareBindingStore, durableObjectStore, rateLimit, RateLimiterDurableObject } from "@miujs/ratelimit";
import { kvSessionStore, session } from "@miujs/session";
import { createCloudflareWorkflow, defineWorkflow } from "@miujs/workflows";

interface KV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}
const kv = (env: Record<string, unknown>) => env.MARKS as KV;

// ---- queue: a job that leaves a mark in KV, dispatched by a route and by a cron schedule ----
const mark = defineJob("mark", {
  input: t.object({ key: t.string(), via: t.string() }),
  run: async ({ input, env, attempt }) => {
    await kv(env).put(`mark:${input.key}`, JSON.stringify({ via: input.via, attempt, at: Date.now() }));
  },
});
const flaky = defineJob("flaky", {
  input: t.object({ key: t.string() }),
  retries: 2,
  backoff: 1,
  run: async ({ input, env, attempt }) => {
    if (attempt < 2) throw new Error(`attempt ${attempt} fails on purpose`);
    await kv(env).put(`mark:${input.key}`, JSON.stringify({ via: "retry", attempt, at: Date.now() }));
  },
});
const jobs = queue({ jobs: [mark, flaky], schedules: [schedule("*/5 * * * *", mark, { key: "cron", via: "cron" })] });

// ---- Cloudflare Workflows (the platform's durable execution) --------------------------------
const nightly = defineWorkflow("kitchen-nightly", {
  input: t.object({ key: t.string() }),
  run: async ({ input, step, env }) => {
    const n = await step.run("first", async () => 41);
    await step.sleep("nap", "1 second");
    const total = await step.run("second", async () => n + 1);
    await (env.MARKS as KV).put(`wf:${input.key}`, JSON.stringify({ total }));
    return { total };
  },
});
// workerd only runs Workflow classes that extend WorkflowEntrypoint (the CLI shims the import on Bun).
export const Nightly = createCloudflareWorkflow(nightly, { base: WorkflowEntrypoint });
// Without `base`: @miujs/workflows loads WorkflowEntrypoint from "cloudflare:workers" itself on workerd.
export const NightlyDefault = createCloudflareWorkflow(nightly);
const cfWorkflows = definePlugin({
  name: "kitchen-workflows",
  cloudflare: () => ({
    kv: ["MARKS"],
    workflows: [
      { binding: "NIGHTLY", name: "kitchen-nightly", className: "Nightly" },
      { binding: "NIGHTLY_DEFAULT", name: "kitchen-nightly-default", className: "NightlyDefault" },
    ],
  }),
});
/** ?class=default uses the Workflow built without `base`. */
const workflowBinding = (env: Record<string, unknown>, cls: string | undefined) => (cls === "default" ? env.NIGHTLY_DEFAULT : env.NIGHTLY);

export { RateLimiterDurableObject };
const doLimiter = durableObjectStore("RATE_LIMITER");
const doLimits = definePlugin({
  name: "kitchen-do-limits",
  cloudflare: () => ({ durableObjects: [{ binding: "RATE_LIMITER", className: "RateLimiterDurableObject" }] }),
});

const routes = {
  // files on R2
  putFile: route.put("/files/:name", {
    params: t.object({ name: t.string({ pattern: "^[a-z0-9.-]+$" }) }),
    handler: async (ctx) => {
      const stored = await ctx.files.put(`docs/${ctx.params.name}`, await ctx.req.arrayBuffer(), { contentType: ctx.headers.get("content-type") ?? "application/octet-stream" });
      return { key: stored.key, size: stored.size, etag: stored.etag ?? null };
    },
  }),
  getFile: route.get("/files/:name", {
    params: t.object({ name: t.string() }),
    handler: async (ctx) => {
      const f = await ctx.files.get(`docs/${ctx.params.name}`);
      if (!f) return new Response("missing", { status: 404 });
      return new Response(f.body, { headers: { "content-type": f.contentType ?? "application/octet-stream" } });
    },
  }),
  listFiles: route.get("/files", { handler: async (ctx) => ({ keys: (await ctx.files.list({ prefix: "docs/" })).files.map((f: { key: string }) => f.key) }) }),
  deleteFile: route.delete("/files/:name", { params: t.object({ name: t.string() }), handler: async (ctx) => void (await ctx.files.delete(`docs/${ctx.params.name}`)) }),
  signFile: route.get("/files/:name/link", {
    params: t.object({ name: t.string() }),
    query: t.object({ method: t.optional(t.enum(["GET", "PUT"] as const)) }),
    handler: async (ctx) => ({ url: await ctx.files.signedUrl(`docs/${ctx.params.name}`, ctx.query.method === "PUT" ? { method: "PUT", contentType: "text/plain", maxSize: 1024, expiresIn: 60 } : { expiresIn: 60 }) }),
  }),
  upload: route.post("/upload", {
    handler: async (ctx) => {
      const saved = await ctx.files.handleUpload(ctx, { maxSize: 64 * 1024, allowedTypes: ["png", "pdf"], prefix: "uploads/" });
      return { files: saved.map((f) => ({ key: f.key, type: f.contentType })) };
    },
  }),

  // queue
  enqueue: route.post("/jobs/:key", {
    params: t.object({ key: t.string() }),
    query: t.object({ flaky: t.optional(t.boolean()) }),
    handler: async (ctx) => (ctx.query.flaky ? ctx.queue.dispatch(flaky, { key: ctx.params.key }) : ctx.queue.dispatch(mark, { key: ctx.params.key, via: "route" })),
  }),
  readMark: route.get("/marks/:key", { params: t.object({ key: t.string() }), handler: async (ctx) => ({ value: JSON.parse((await kv(ctx.env).get(ctx.params.key)) ?? "null") }) }),

  // rate limits
  limited: route.get("/limited", { name: "limited", handler: () => ({ ok: true }) }),
  limitedDo: route.get("/limited-do", { name: "limited_do", handler: () => ({ ok: true }) }),

  // bots: a page crawlers get from the Cache API store
  post: route.get("/posts/:id", {
    params: t.object({ id: t.string() }),
    handler: (ctx) => ({ id: ctx.params.id, servedTo: ctx.visitor.kind, renderedAt: Date.now() }),
  }),
  visitor: route.get("/visitor", { handler: (ctx) => ({ visitor: ctx.visitor, cf: (ctx.req as { cf?: unknown }).cf ?? null }) }),

  // KV sessions
  counter: route.post("/counter", {
    handler: (ctx) => {
      const n = Number(ctx.session.get("n") ?? 0) + 1;
      ctx.session.set("n", n);
      return { n };
    },
  }),

  // Cloudflare Workflows
  startWorkflow: route.post("/workflows/:key", {
    params: t.object({ key: t.string() }),
    query: t.object({ class: t.optional(t.enum(["base", "default"] as const)) }),
    handler: async (ctx) => {
      const binding = workflowBinding(ctx.env, ctx.query.class) as { create(o: { id?: string; params: unknown }): Promise<{ id: string }> };
      const inst = await binding.create({ id: ctx.params.key, params: { key: ctx.params.key } });
      return { id: inst.id };
    },
  }),
  workflowStatus: route.get("/workflows/:key", {
    params: t.object({ key: t.string() }),
    query: t.object({ class: t.optional(t.enum(["base", "default"] as const)) }),
    handler: async (ctx) => {
      const binding = workflowBinding(ctx.env, ctx.query.class) as { get(id: string): Promise<{ status(): Promise<unknown> }> };
      return { status: await (await binding.get(ctx.params.key)).status() };
    },
  }),
};

export default miu({
  name: "kitchen",
  logLevel: "warn",
  routes: [routes],
  plugins: [
    session({ store: kvSessionStore("SESSIONS") }),
    files({ store: r2Store("FILES") }),
    jobs,
    rateLimit({ store: cloudflareBindingStore("RL", { limit: 5, period: 10 }), rules: [{ name: "binding", match: { route: "limited" }, limit: 5, window: "10s" }] }),
    rateLimit({ store: doLimiter, rules: [{ name: "do", match: { route: "limited_do" }, limit: 3, window: "1m" }] }),
    bots({ cache: { store: cacheApiStore() } }),
    cfWorkflows,
    doLimits,
  ],
});
