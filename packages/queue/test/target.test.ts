import { afterEach, expect, test } from "bun:test";
import { t } from "miujs";
import { defineJob, queue, schedule } from "../src/index.ts";

afterEach(() => {
  delete process.env.MIU_TARGET;
});

const ping = defineJob("ping", { input: t.object({}), run: () => {} });

test("plain queue() uses memory when not targeting Cloudflare", () => {
  const q = queue({ jobs: [ping] });
  expect(q.cloudflare?.()).toEqual({});
  q.stop();
});

test("plain queue() declares Cloudflare queue bindings and crons when MIU_TARGET=cloudflare", () => {
  process.env.MIU_TARGET = "cloudflare";
  const q = queue({ jobs: [ping], schedules: [schedule("*/5 * * * *", ping, {})] });
  expect(q.cloudflare?.()).toEqual({ queues: { producers: ["JOBS"], consumers: ["JOBS"] }, crons: ["*/5 * * * *"] });
  q.stop();
});
