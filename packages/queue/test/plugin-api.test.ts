import { expect, test } from "bun:test";
import { t } from "miujs";
import { defineJob, memoryQueue, queue, schedule } from "../src/index.ts";

const a = defineJob("a", { input: t.object({}), run: () => {} });
const b = defineJob("b", { input: t.object({}), run: () => {} });

test("hasJob() and jobs() list what the queue runs, schedules included", () => {
  const q = queue({ adapter: memoryQueue(), jobs: [a], schedules: [schedule("0 * * * *", b)] });
  expect(q.hasJob("a")).toBe(true);
  expect(q.hasJob("b")).toBe(true);
  expect(q.hasJob("c")).toBe(false);
  expect(q.jobs().map((j) => j.name)).toEqual(["a", "b"]);
  expect(q.jobs()[0]).toBe(a);
});
