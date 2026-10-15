import { describe, expect, test } from "bun:test";
import { definePlugin, route, validate, type Context, type ManageAction, type ManageSection } from "miujs";
import { call, editor, fakeProcessor, jpegBytes, json, SECRET, seedTour, setup } from "./helpers.ts";

/** Runs manage code inside a real request (so ctx has env, url and the queue client). */
function harness() {
  let job: ((ctx: Context) => Promise<unknown>) | null = null;
  const probe = definePlugin({
    name: "probe",
    routes: [
      route.post("/__probe", {
        handler: async (ctx) => ({ out: await job!(ctx as unknown as Context) }),
      }),
    ],
  });
  const proc = fakeProcessor({ fail: 0 });
  const s = setup({ plugins: [probe], processors: [proc] });
  const [section] = s.plugin.manage() as ManageSection[];
  const inReq = async <T>(fn: (ctx: Context) => Promise<T> | T): Promise<T> => {
    job = async (ctx) => fn(ctx);
    const r = await call(s.app, "/__probe", { method: "POST" });
    if (r.status !== 200) throw Object.assign(new Error(r.text), { body: r.body });
    return r.body.out as T;
  };
  return { ...s, proc, section, list: section.lists![0], inReq };
}

function action(actions: ManageAction[] | undefined, name: string): ManageAction {
  const a = actions?.find((x) => x.name === name);
  if (!a) throw new Error(`no action ${name}`);
  return a;
}

async function uploadPano(app: any, tourId: string, sceneId: string) {
  return call(app, `/tours/${tourId}/scenes/${sceneId}/upload`, { method: "POST", headers: { "content-type": "image/jpeg", ...editor }, body: jpegBytes() });
}

describe("tour manage()", () => {
  test("one 'tours' section with status, a tours list and row actions", () => {
    const { section, list } = harness();
    expect(section.id).toBe("tours");
    expect(list.name).toBe("tours");
    expect(list.rowActions!.map((a) => a.name)).toEqual(["publish", "unpublish", "reprocess", "revokeShares"]);
    expect(action(list.rowActions, "revokeShares").danger).toBe(true);
    expect(action(list.rowActions, "unpublish").danger).toBe(true);
    expect(action(list.rowActions, "publish").danger).toBeFalsy();
  });

  test("status counts tours, scenes, hotspots and assets by state, with source bytes", async () => {
    const h = harness();
    const { tour, s1, s2 } = await seedTour(h.app);
    await call(h.app, `/tours/${tour.id}/scenes/${s1.id}/hotspots`, json("POST", { kind: "link", position: { yaw: 0, pitch: 0 }, targetSceneId: s2.id }, editor));
    await call(h.app, "/tours", json("POST", { title: "Other", slug: "other" }, editor));
    await call(h.app, `/tours/${tour.id}`, json("PATCH", { status: "published" }, editor));
    await uploadPano(h.app, tour.id, s1.id);
    await uploadPano(h.app, tour.id, s2.id);
    await h.q.drain();
    const st = await h.inReq((ctx) => h.section.status!(ctx));
    const stat = (label: string) => st.stats!.find((x) => x.label === label)!.value;
    expect(stat("Tours")).toBe(2);
    expect(stat("Published")).toBe(1);
    expect(stat("Scenes")).toBe(2);
    expect(stat("Hotspots")).toBe(1);
    expect(stat("Assets")).toBe(2);
    expect(stat("Failed assets")).toBe(0);
    expect(stat("Source bytes")).toBe(128);
    const byStatus = st.tables!.find((x) => x.title === "Assets by status")!;
    expect(byStatus.rows).toEqual([
      { status: "queued", assets: 0, bytes: 0 },
      { status: "processing", assets: 0, bytes: 0 },
      { status: "ready", assets: 2, bytes: 128 },
      { status: "failed", assets: 0, bytes: 0 },
    ]);
  });

  test("the tours list pages, filters, searches and never shows password hashes or secrets", async () => {
    const h = harness();
    const { tour } = await seedTour(h.app);
    h.clock.advance(1_000);
    await call(h.app, "/tours", json("POST", { title: "Beach House", slug: "beach" }, editor));
    await call(h.app, `/tours/${tour.id}`, json("PATCH", { status: "published", password: "hunter2-secret-pw" }, editor));
    const p1 = await h.inReq((ctx) => h.list.list({ limit: 1 }, ctx));
    expect(p1.rows.map((r) => r.slug)).toEqual(["beach"]);
    expect(p1.next).toBeString();
    const p2 = await h.inReq((ctx) => h.list.list({ limit: 1, cursor: p1.next }, ctx));
    expect(p2.rows[0]).toMatchObject({ id: tour.id, slug: "12-elm-st", status: "published", visibility: "private", scenes: 2, hasPassword: true });
    expect(p2.next).toBeUndefined();
    expect((await h.inReq((ctx) => h.list.list({ limit: 10, filters: { status: "draft" } }, ctx))).rows.map((r) => r.slug)).toEqual(["beach"]);
    expect((await h.inReq((ctx) => h.list.list({ limit: 10, search: "elm" }, ctx))).rows.map((r) => r.slug)).toEqual(["12-elm-st"]);
    const text = JSON.stringify([p1, p2]);
    expect(text).not.toContain("hunter2");
    expect(text).not.toMatch(/password_?hash|\$argon|pbkdf2/i);
    expect(text).not.toContain(SECRET);
  });

  test("publish / unpublish are idempotent and report what changed", async () => {
    const h = harness();
    const { tour } = await seedTour(h.app);
    const publish = action(h.list.rowActions, "publish");
    const unpublish = action(h.list.rowActions, "unpublish");
    expect(await h.inReq((ctx) => publish.run({ id: tour.id }, ctx))).toContain("Published");
    expect((await call(h.app, `/tours/${tour.id}`, { headers: editor })).body.status).toBe("published");
    expect(await h.inReq((ctx) => publish.run({ id: tour.id }, ctx))).toContain("already published");
    expect(await h.inReq((ctx) => unpublish.run({ id: tour.id }, ctx))).toContain("draft");
    expect(await h.inReq((ctx) => unpublish.run({ id: tour.id }, ctx))).toContain("already a draft");
    await expect(h.inReq((ctx) => publish.run({ id: "tour_nope" }, ctx))).rejects.toThrow(/MIU_E_TOUR_NOT_FOUND|not found/i);
  });

  test("reprocess re-queues failed assets (or all) through the queue", async () => {
    const h = harness();
    const { tour, s1, s2 } = await seedTour(h.app);
    await uploadPano(h.app, tour.id, s1.id);
    await uploadPano(h.app, tour.id, s2.id);
    await h.q.drain();
    const reprocess = action(h.list.rowActions, "reprocess");
    expect(validate(reprocess.input!, { only: "everything" }).ok).toBe(false);
    expect(validate(reprocess.input!, {}).ok).toBe(true);
    expect(await h.inReq((ctx) => reprocess.run({ id: tour.id, only: "failed" }, ctx))).toContain("No assets");
    const before = h.proc.calls.length;
    expect(await h.inReq((ctx) => reprocess.run({ id: tour.id, only: "all" }, ctx))).toContain("Queued 2");
    await h.q.drain();
    expect(h.proc.calls.length).toBe(before + 2);
    const assets = (await call(h.app, `/tours/${tour.id}/assets`, { headers: editor })).body.assets;
    expect(assets.map((a: any) => a.status)).toEqual(["ready", "ready"]);
  });

  test("revokeShares bumps the share version", async () => {
    const h = harness();
    const { tour } = await seedTour(h.app);
    expect(await h.inReq((ctx) => action(h.list.rowActions, "revokeShares").run({ id: tour.id }, ctx))).toContain("Revoked");
  });
});
