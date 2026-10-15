import { describe, expect, test } from "bun:test";
import { miu, t } from "miujs";
import { sqlite } from "@miujs/db";
import { defineAction, defineWorkflow, manual, workflows, type WorkflowSpec } from "@miujs/workflows";
import { WorkflowLoader, workflowStore } from "../../src/ui/workflow-store.ts";
import { testClock } from "../helpers.ts";

const spec = (name: string, message = "hi"): WorkflowSpec => ({
  name,
  trigger: { type: "event", event: "contacts.created" },
  steps: [{ id: "say", type: "action", action: "log", params: { message } }],
});

describe("admin_workflows storage", () => {
  test("each save is a new version; list shows the latest and the published one", async () => {
    const store = workflowStore(sqlite());
    const v1 = await store.save(spec("greet"), "ann");
    const v2 = await store.save(spec("greet", "hello"), "bob");
    await store.save(spec("other"), "ann");
    expect([v1.version, v2.version]).toEqual([1, 2]);
    expect(v2).toMatchObject({ name: "greet", status: "draft", createdBy: "bob" });
    expect((await store.get("greet"))!.spec.steps[0]).toMatchObject({ params: { message: "hello" } });
    expect((await store.get("greet", 1))!.spec.steps[0]).toMatchObject({ params: { message: "hi" } });
    expect(await store.get("nope")).toBeNull();
    expect((await store.versions("greet")).map((v) => v.version)).toEqual([2, 1]);
    expect(await store.list()).toEqual([
      expect.objectContaining({ name: "greet", latest: 2, published: null }),
      expect.objectContaining({ name: "other", latest: 1, published: null }),
    ]);
  });

  test("publishing archives the previously published version", async () => {
    const store = workflowStore(sqlite());
    await store.save(spec("greet"), "ann");
    await store.save(spec("greet", "v2"), "ann");
    expect(await store.publish("greet", 1, "ann")).toBe(true);
    expect(await store.publish("greet", 2, "ann")).toBe(true);
    expect(await store.publish("greet", 9, "ann")).toBe(false);
    expect((await store.versions("greet")).map((v) => [v.version, v.status])).toEqual([
      [2, "published"],
      [1, "archived"],
    ]);
    expect((await store.published()).map((w) => [w.name, w.version])).toEqual([["greet", 2]]);
    expect((await store.list())[0]).toMatchObject({ published: 2 });
    await store.unpublish("greet");
    expect(await store.published()).toEqual([]);
  });

  test("stored specs are plain JSON (no prototype tricks survive)", async () => {
    const store = workflowStore(sqlite());
    const s = JSON.parse('{"name":"x","trigger":{"type":"manual"},"steps":[],"__proto__":{"polluted":true}}');
    await store.save(s, null);
    const got = await store.get("x");
    expect(({} as any).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(got!.spec)).toBe(Object.prototype);
  });
});

describe("loading published versions into the workflows engine", () => {
  const setup = async () => {
    const database = sqlite();
    const clock = testClock();
    const ran: string[] = [];
    const shout = defineAction("shout", { params: t.object({ text: t.string() }), run: (p) => void ran.push(p.text) });
    const code = defineWorkflow("code-defined", { trigger: manual(), run: () => {} });
    const wf = workflows({ workflows: [code], clock });
    const app = miu({ logLevel: "silent", plugins: [wf] });
    await app.ready();
    const store = workflowStore(database);
    const loader = new WorkflowLoader({ target: () => wf, actions: () => [shout], ttlMs: 0, now: () => clock.now() });
    return { wf, store, loader, ran, clock };
  };

  test("only published versions run; drafts and unpublished ones do not", async () => {
    const { wf, store, loader, ran } = await setup();
    const s: WorkflowSpec = { name: "yell", trigger: { type: "event", event: "contacts.created" }, steps: [{ id: "s", type: "action", action: "shout", params: { text: "{{ data.name }}" } }] };
    await store.save(s, "ann");
    await loader.sync(store);
    expect((await wf.emit("contacts.created", { name: "draft" })).started).toEqual([]);

    await store.publish("yell", 1, "ann");
    await loader.sync(store);
    expect((await wf.emit("contacts.created", { name: "Ann" })).started.map((x) => x.workflow)).toEqual(["yell"]);
    await wf.drain();
    expect(ran).toEqual(["Ann"]);

    await store.unpublish("yell");
    await loader.sync(store);
    expect((await wf.emit("contacts.created", { name: "gone" })).started).toEqual([]);
    expect(wf.engine.opts.workflows.has("code-defined")).toBe(true);
  });

  test("a new published version replaces the old one", async () => {
    const { wf, store, loader } = await setup();
    await store.save(spec("greet", "one"), null);
    await store.publish("greet", 1, null);
    await loader.sync(store);
    await store.save(spec("greet", "two"), null);
    await store.publish("greet", 2, null);
    await loader.sync(store);
    expect((wf.engine.opts.workflows.get("greet") as any).spec.steps[0].params.message).toBe("two");
    expect(loader.loaded()).toEqual({ greet: 2 });
  });

  test("never replaces a code-defined workflow; broken specs are skipped and reported", async () => {
    const { wf, store, loader } = await setup();
    await store.save({ name: "code-defined", trigger: { type: "manual" }, steps: [{ id: "a", type: "wait", duration: "1h" }] }, null);
    await store.publish("code-defined", 1, null);
    await store.save({ name: "broken", trigger: { type: "manual" }, steps: [{ id: "a", type: "action", action: "missing" }] } as any, null);
    await store.publish("broken", 1, null);
    const report = await loader.sync(store);
    expect(report.errors.map((e) => e.name).sort()).toEqual(["broken", "code-defined"]);
    expect(wf.engine.opts.workflows.get("code-defined")!.spec).toBeUndefined();
    expect(wf.engine.opts.workflows.has("broken")).toBe(false);
  });

  test("ensure() re-reads storage only after the TTL", async () => {
    const { store, wf } = await setup();
    let now = 0;
    const loader = new WorkflowLoader({ target: () => wf, actions: () => [], ttlMs: 1000, now: () => now });
    await loader.ensure(store);
    await store.save(spec("late"), null);
    await store.publish("late", 1, null);
    await loader.ensure(store);
    expect(wf.engine.opts.workflows.has("late")).toBe(false);
    now = 1001;
    await loader.ensure(store);
    expect(wf.engine.opts.workflows.has("late")).toBe(true);
  });
});

describe("loading goes through the public register/unregister API", () => {
  test("a changed version is unregistered then registered; unpublishing unregisters", async () => {
    const calls: string[] = [];
    const known = new Set<string>();
    const target = {
      has: (n: string) => known.has(n),
      register: (d: { name: string }) => void (calls.push(`register ${d.name}`), known.add(d.name)),
      unregister: (n: string) => (calls.push(`unregister ${n}`), known.delete(n)),
    };
    const store = workflowStore(sqlite());
    const loader = new WorkflowLoader({ target: () => target, actions: () => [], ttlMs: 0 });
    await store.save(spec("greet", "one"), null);
    await store.publish("greet", 1, null);
    await loader.sync(store);
    await store.save(spec("greet", "two"), null);
    await store.publish("greet", 2, null);
    await loader.sync(store);
    await store.unpublish("greet");
    await loader.sync(store);
    expect(calls).toEqual(["register greet", "unregister greet", "register greet", "unregister greet"]);
  });

  test("refresh() re-reads on demand, at most once per minGapMs", async () => {
    const store = workflowStore(sqlite());
    let now = 0;
    const known = new Set<string>();
    const target = { has: (n: string) => known.has(n), register: (d: { name: string }) => void known.add(d.name), unregister: (n: string) => known.delete(n) };
    const loader = new WorkflowLoader({ target: () => target, actions: () => [], ttlMs: 60_000, minRefreshMs: 5_000, now: () => now });
    await loader.ensure(store);
    await store.save(spec("late"), null);
    await store.publish("late", 1, null);
    await loader.ensure(store);
    expect(known.has("late")).toBe(false); // still inside the TTL
    await loader.refresh(store);
    expect(known.has("late")).toBe(true);
    await store.unpublish("late");
    now = 1000;
    await loader.refresh(store); // throttled
    expect(known.has("late")).toBe(true);
    now = 6000;
    await loader.refresh(store);
    expect(known.has("late")).toBe(false);
  });
});
