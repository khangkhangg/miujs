import { describe, expect, test } from "bun:test";
import { Miu } from "../../src/core/app.ts";
import { ValidationError } from "../../src/core/errors.ts";
import { t } from "../../src/core/schema.ts";
import { defineWorkflow } from "../../src/adapters/cloudflare/workflows.ts";
import { hyperdriveUrl } from "../../src/adapters/cloudflare/hyperdrive.ts";
import { toWorker, workerEnv } from "../../src/adapters/cloudflare/worker.ts";
import type { Workflow, WorkflowStep } from "../../src/adapters/cloudflare/types.ts";
import * as cf from "../../src/adapters/cloudflare/index.ts";
import { fakeBatch, fakeMessage } from "./fakes.ts";

const fakeWorkflow = () => {
  const created: unknown[] = [];
  const wf: Workflow & { created: unknown[] } = {
    created,
    async create(o) {
      created.push(o);
      return { id: o?.id ?? "generated", status: async () => ({ status: "queued" }) };
    },
    async get(id) {
      return { id, status: async () => ({ status: "running" }) };
    },
  };
  return wf;
};

const step: WorkflowStep = { do: (_n, fn) => fn(), sleep: async () => {} };

describe("defineWorkflow", () => {
  const signup = defineWorkflow("SIGNUP", t.object({ email: t.string() }), async (event, s) => {
    const email: string = event.payload.email;
    return s.do("welcome", async () => `sent:${email}`);
  });

  test("create validates params and calls the binding", async () => {
    const SIGNUP = fakeWorkflow();
    const inst = await signup.create({ SIGNUP }, { email: "a@b.c" }, { id: "w1" });
    expect(inst.id).toBe("w1");
    expect(SIGNUP.created).toEqual([{ id: "w1", params: { email: "a@b.c" } }]);
    await expect(signup.create({ SIGNUP }, { email: 1 } as never)).rejects.toBeInstanceOf(ValidationError);
    expect(SIGNUP.created).toHaveLength(1);
    expect((await signup.get({ SIGNUP }, "w1")).id).toBe("w1");
  });

  test("throws a clear error when the binding is missing", async () => {
    await expect(signup.create({}, { email: "x" })).rejects.toThrow(/SIGNUP/);
  });

  test("run validates the event payload and runs the steps", async () => {
    const event = { payload: { email: "a@b.c" }, timestamp: new Date(), instanceId: "w1" };
    expect(await signup.run(event, step)).toBe("sent:a@b.c");
    await expect(signup.run({ ...event, payload: {} as never }, step)).rejects.toBeInstanceOf(ValidationError);
  });
});

test("hyperdriveUrl returns the connection string", () => {
  expect(hyperdriveUrl({ connectionString: "postgres://u:p@h:5432/db" } as never)).toBe("postgres://u:p@h:5432/db");
});

describe("toWorker", () => {
  test("exposes fetch, queue and scheduled and records env", async () => {
    const app = new Miu().get("/", (c) => ({ v: (c.env as { V: string }).V }));
    const env = workerEnv<{ V: string }>();
    const ran: string[] = [];
    const worker = toWorker(app, {
      env,
      queue: async (batch) => void ran.push(`queue:${batch.messages.length}`),
      scheduled: async (controller) => void ran.push(`cron:${controller.cron}`),
    });
    expect(() => env.current).toThrow(/before/);
    const res = await worker.fetch(new Request("http://x/"), { V: "1" }, { waitUntil() {} });
    expect(await res.json()).toEqual({ v: "1" });
    expect(env.current.V).toBe("1");
    await worker.queue!(fakeBatch([fakeMessage({ id: "1", name: "x", payload: 1 })]), { V: "2" }, { waitUntil() {} });
    await worker.scheduled!({ cron: "* * * * *", scheduledTime: 0, noRetry() {} }, { V: "3" }, { waitUntil() {} });
    expect(ran).toEqual(["queue:1", "cron:* * * * *"]);
    expect(env.current.V).toBe("3");
  });

  test("omits handlers that are not given", () => {
    const worker = toWorker(new Miu());
    expect(Object.keys(worker)).toEqual(["fetch"]);
  });
});

test("index re-exports the adapter API", () => {
  for (const name of [
    "kvStore", "d1Store", "doStore", "MiuStoreObject", "cloudflareQueue", "queueConsumer",
    "r2Files", "uploadHandler", "defineWorkflow", "hyperdriveUrl", "toWorker", "workerEnv",
  ]) {
    expect(typeof (cf as Record<string, unknown>)[name]).toBe("function");
  }
});
