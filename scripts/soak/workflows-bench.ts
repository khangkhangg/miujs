// Workflow throughput: runs/sec of a 3-step JSON workflow on the memory store and on
// dbRunStore(sqlite), plus step-journal growth per run.
//
//   bun scripts/soak/workflows-bench.ts [runs=2000] [concurrency=50]
import { miu, t } from "../../packages/miujs/src/index.ts";
import { sqlite } from "../../packages/db/src/index.ts";
import { memoryQueue } from "../../packages/queue/src/index.ts";
import { dbRunStore, defineAction, fromJson, memoryRunStore, workflows, type RunStore } from "../../packages/workflows/src/index.ts";

const RUNS = Number(process.argv[2] ?? 2000);
const CONC = Number(process.argv[3] ?? 50);

const touch = defineAction("touch", { params: t.object({ id: t.string(), n: t.number() }), retries: 0, run: (p) => ({ id: p.id, n: p.n + 1 }) });
const spec = {
  name: "bench3",
  trigger: { type: "manual" },
  steps: [
    { id: "a", type: "action", action: "touch", params: { id: "{{ input.id }}", n: 0 } },
    { id: "b", type: "action", action: "touch", params: { id: "{{ input.id }}", n: "{{ steps.a.output.n }}" } },
    { id: "c", type: "condition", if: "steps.b.output.n == 2", then: [{ id: "d", type: "action", action: "touch", params: { id: "{{ input.id }}", n: "{{ steps.b.output.n }}" } }] },
  ],
};

async function bench(label: string, store: RunStore, after?: () => Promise<string>) {
  const mq = memoryQueue();
  const wf = workflows({ workflows: [fromJson(spec, { actions: [touch] })], store, adapter: mq, env: {} });
  const app = miu({ logLevel: "silent", plugins: [wf] });
  await app.ready();
  // warm-up
  await wf.start("bench3", { id: "warm" });
  await wf.drain();
  const t0 = performance.now();
  let next = 0;
  const ids: string[] = [];
  await Promise.all(
    Array.from({ length: CONC }, async () => {
      while (next < RUNS) {
        next++;
        ids.push((await wf.start("bench3", { id: `c${next}` })).id);
      }
    }),
  );
  await wf.drain();
  const ms = performance.now() - t0;
  const runs = await wf.listRuns({ status: "completed", limit: RUNS + 10 });
  const done = runs.length - 1;
  const sample = await wf.getRun(ids[0]);
  const stepBytes = JSON.stringify(sample.steps).length;
  console.log(
    `${label.padEnd(18)} ${String(done).padStart(5)} runs in ${ms.toFixed(0).padStart(6)} ms = ${((done / ms) * 1000).toFixed(0).padStart(6)} runs/s; ` +
      `steps/run=${sample.steps.length}, journal JSON ~${stepBytes} B/run ${after ? await after() : ""}`,
  );
  wf.stop();
}

await bench("memory store", memoryRunStore({ maxFinishedRuns: RUNS + 10 }));
const db = sqlite(":memory:");
await bench("dbRunStore(sqlite)", dbRunStore(db), async () => {
  const q = async (sql: string) => (await db.prepare(sql).first<Record<string, number>>())!;
  const steps = await q("SELECT COUNT(*) AS n, SUM(LENGTH(output)) + SUM(COALESCE(LENGTH(error),0)) + SUM(LENGTH(name)) AS b FROM workflow_steps");
  const runs = await q("SELECT COUNT(*) AS n, SUM(LENGTH(input)) + SUM(COALESCE(LENGTH(output),0)) + SUM(LENGTH(trigger_info)) AS b FROM workflow_runs");
  return `| sqlite rows: runs=${runs.n} steps=${steps.n} (${(steps.n / runs.n).toFixed(1)}/run), ~${Math.round((steps.b + runs.b) / runs.n)} B payload/run`;
});
