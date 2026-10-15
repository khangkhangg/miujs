import type { Scenario } from "../../../bench/lib/scenario.ts";

export default {
  name: "fixture",
  async setup(base) {
    const r = await fetch(`${base}/seed`, { method: "POST" });
    return { id: ((await r.json()) as { id: string }).id };
  },
  steps: [
    { name: "home", weight: 3, run: (base) => fetch(`${base}/`) },
    { name: "item", weight: 1, run: (base, ctx) => fetch(`${base}/items/${(ctx as { id: string }).id}`) },
    { name: "broken", weight: 1, run: (base) => fetch(`${base}/boom`) },
  ],
} satisfies Scenario;
