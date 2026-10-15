import { miu, type MiuOptions, type Plugin } from "miujs";
import { manualClock, memoryQueue, type MemoryQueue } from "@miujs/queue";
import { workflows, type WorkflowDef, type WorkflowsOptions } from "../src/index.ts";

export const T0 = Date.UTC(2026, 0, 5, 8, 0, 0); // a Monday, 08:00 UTC

/**
 * Let queued work run without moving the fake clock: yields macrotasks until the memory queue
 * has nothing ready or running. (`drain()` also skips delays by advancing the clock.)
 */
export async function settle(mq: MemoryQueue): Promise<void> {
  let quiet = 0;
  for (let i = 0; i < 2000; i++) {
    await new Promise((r) => setTimeout(r, 0));
    const s = mq.inspect!() as { pending: number; running: number };
    if (s.pending === 0 && s.running === 0) {
      if (++quiet >= 3) return;
    } else quiet = 0;
  }
  throw new Error("queue did not settle");
}

export function setup(defs: WorkflowDef<any>[], over: Partial<WorkflowsOptions> = {}, app: Partial<MiuOptions> & { plugins?: Plugin[] } = {}) {
  const clock = manualClock(T0);
  const mq = memoryQueue({ clock });
  const wf = workflows({ workflows: defs, adapter: mq, clock, ...over });
  const a = miu({ logLevel: "silent", ...app, plugins: [...(app.plugins ?? []), wf] });
  return { clock, mq, wf, app: a, ready: () => a.ready(), settle: () => settle(mq) };
}
