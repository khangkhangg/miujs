/**
 * Compile-time check (`bun run typecheck:cf`): MiuJS's hand-written Cloudflare binding interfaces
 * (src/adapters/cloudflare/types.ts, src/realtime/cf-types.ts) must accept the real bindings from
 * @cloudflare/workers-types. Type-checked with the workers-types globals in place of DOM, the way a
 * Worker project compiles. Never executed.
 */
import {
  d1Store,
  doStore,
  kvStore,
  MiuStoreObject,
  queueConsumer,
  cloudflareQueue,
  r2Files,
  uploadHandler,
  defineWorkflow,
  hyperdriveUrl,
  toWorker,
  type CloudflareJobMessage,
} from "../../../src/adapters/cloudflare/index.ts";
import type * as Miu from "../../../src/adapters/cloudflare/index.ts";
import { MiuRoom, roomRoute } from "../../../src/realtime/index.ts";
import type * as MiuRt from "../../../src/realtime/index.ts";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { Miu as App } from "../../../src/index.ts";
import { t } from "../../../src/core/schema.ts";

declare const env: {
  KV: KVNamespace;
  DB: D1Database;
  FILES: R2Bucket;
  JOBS: Queue<CloudflareJobMessage>;
  STORE: DurableObjectNamespace;
  ROOMS: DurableObjectNamespace;
  WF: Workflow<{ n: number }>;
  HD: Hyperdrive;
};
declare const ctx: ExecutionContext;
declare const doState: DurableObjectState;
declare const batch: MessageBatch<CloudflareJobMessage>;
declare const controller: ScheduledController;
declare const event: WorkflowEvent<{ n: number }>;
declare const step: WorkflowStep;

// ----- Workers KV / D1 / R2 / Durable Objects / Hyperdrive -----
kvStore(env.KV);
kvStore(() => env.KV);
d1Store(env.DB);
r2Files(env.FILES);
uploadHandler({ bucket: env.FILES });
uploadHandler({ bucket: () => env.FILES });
doStore(env.STORE);
new MiuStoreObject(doState, env);
hyperdriveUrl(env.HD);

// Direct assignments pin each interface, not just the call sites.
export const kv: Miu.KVNamespace = env.KV;
export const d1: Miu.D1Database = env.DB;
export const d1stmt: Miu.D1PreparedStatement = env.DB.prepare("select 1");
export const r2: Miu.R2Bucket = env.FILES;
export const r2obj: Miu.R2Object | null = await env.FILES.head("k");
export const r2body: Miu.R2ObjectBody | null = await env.FILES.get("k");
export const ns: Miu.DurableObjectNamespace = env.STORE;
export const state: Miu.DurableObjectState = doState;
export const hd: Miu.Hyperdrive = env.HD;

// ----- Queues -----
declare const jobs: Parameters<typeof cloudflareQueue>[0];
export const producer: Miu.QueueProducer<CloudflareJobMessage> = env.JOBS;
cloudflareQueue(jobs, env.JOBS);
export const miuBatch: Miu.MessageBatch<CloudflareJobMessage> = batch;
await queueConsumer(jobs)(batch, env, ctx);

// ----- Workflows -----
export const wf: Miu.Workflow<{ n: number }> = env.WF;
export const wfEvent: Miu.WorkflowEvent<{ n: number }> = event;
export const wfStep: Miu.WorkflowStep = step;
const flow = defineWorkflow("WF", t.object({ n: t.number() }), async (e, st) => st.do("x", async () => e.payload.n));
await flow.create(env, { n: 1 });
await flow.run(event, step);

// ----- Worker entry: the result must be a valid ExportedHandler -----
const app = new App();
export const worker: ExportedHandler<typeof env, CloudflareJobMessage> = toWorker<typeof env>(app, {
  queue: queueConsumer(jobs),
  scheduled: async () => {},
});
export const sc: Miu.ScheduledController = controller;

// ----- Realtime: WebSocketPair, hibernation DurableObjectState, room namespaces -----
export const Pair: MiuRt.WebSocketPairCtor = WebSocketPair;
const pair = new WebSocketPair();
export const cfWs: MiuRt.CfWebSocket = pair[0];
export const rtState: MiuRt.DurableObjectState = doState;
export const rtNs: MiuRt.DurableObjectNamespace = env.ROOMS;
export class Room extends MiuRoom<{ name: string }, typeof env> {}
new Room(doState, env);
roomRoute(env.ROOMS, () => "lobby");
roomRoute((c) => (c.env as typeof env).ROOMS, () => "lobby");

// A Durable Object class built on MiuRoom must satisfy the runtime's DurableObject shape.
export const asDurableObject: DurableObject = new Room(doState, env);
