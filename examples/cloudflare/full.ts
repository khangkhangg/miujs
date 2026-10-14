// A fuller Worker: D1 sessions, KV response cache, Durable Object rate limiting,
// R2 uploads, a Cloudflare Queue for background jobs, and an MCP endpoint.
// Bindings are declared (commented) in wrangler.toml; set `main = "full.ts"` to run it.
import {
  Miu,
  t,
  mcp,
  openapi,
  sessions,
  session,
  cache,
  rateLimit,
  createQueue,
  memoryQueueDriver,
  type Middleware,
} from "../../src/index.ts";
import {
  MiuStoreObject,
  cloudflareQueue,
  d1Store,
  doStore,
  kvStore,
  queueConsumer,
  r2Files,
  toWorker,
  uploadHandler,
  workerEnv,
  type CloudflareJobMessage,
  type D1Database,
  type DurableObjectNamespace,
  type KVNamespace,
  type QueueProducer,
  type R2Bucket,
} from "../../src/adapters/cloudflare/index.ts";

type Bindings = {
  DB: D1Database;
  CACHE: KVNamespace;
  FILES: R2Bucket;
  JOBS: QueueProducer<CloudflareJobMessage>;
  MIU_STORE: DurableObjectNamespace;
  SESSION_SECRET: string;
};

// Bindings only exist per invocation; `env.current` is filled by toWorker() below,
// so stores can be created once at module scope with binding getters.
const env = workerEnv<Bindings>();
const sessionStore = d1Store(() => env.current.DB); // strongly consistent
const cacheStore = kvStore(() => env.current.CACHE); // read-heavy, eventually consistent
const counters = doStore(() => env.current.MIU_STORE); // atomic incr for rate limits
const files = r2Files(() => env.current.FILES);

// Job definitions live on a Miu queue; Cloudflare Queues does the delivery.
const jobs = createQueue({ driver: memoryQueueDriver() });
jobs.define("thumbnail", {
  schema: t.object({ key: t.string() }),
  retries: 3,
  handler: async ({ key }) => {
    const original = await files.get(key);
    if (!original) return;
    await files.put(`thumbs/${key}`, await original.arrayBuffer(), { contentType: original.httpMetadata?.contentType });
  },
});

const upload = uploadHandler({ bucket: (c) => c.env.FILES, maxBytes: 5_000_000, allowedTypes: ["image/*"] });

// sessions() needs the secret from env, so build it on the first request.
let sessionMw: Middleware | undefined;
const lazySessions: Middleware = (c, next) =>
  (sessionMw ??= sessions({ store: sessionStore, secret: (c.env as Bindings).SESSION_SECRET }))(c, next);

const app = new Miu<{ Bindings: Bindings }>({ name: "miu-worker-full", version: "0.1.0" })
  .use(openapi())
  .use(mcp())
  .use(rateLimit({ store: counters, limit: 100, window: 60 }))
  .use("/me", lazySessions)
  .use("/stats", cache({ store: cacheStore, ttl: 300 }))
  .get("/me", async (c) => {
    const s = session(c);
    const visits = ((await s.get<number>("visits")) ?? 0) + 1;
    await s.set("visits", visits);
    return { visits };
  })
  .get("/stats", async () => ({ files: (await files.list()).objects.length }))
  .post(
    "/files",
    { summary: "Upload an image", tool: false },
    async (c) => {
      const res = await upload(c);
      if (res.status === 201) {
        const { key } = (await res.clone().json()) as { key: string };
        await cloudflareQueue(jobs, c.env.JOBS).dispatch("thumbnail", { key });
      }
      return res;
    },
  )
  .get("/files/:key", { params: t.object({ key: t.string() }) }, (c) => files.serve(c, c.params.key));

export { MiuStoreObject };
export default toWorker(app, { env, queue: queueConsumer(jobs) });
