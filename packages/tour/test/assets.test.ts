import { describe, expect, test } from "bun:test";
import { miu } from "miujs";
import { sqlite } from "@miujs/db";
import { files, memoryStore } from "@miujs/files";
import { defineJob, memoryQueue, queue } from "@miujs/queue";
import { t } from "miujs";
import { tour } from "../src/index.ts";
import { call, editor, fakeAccess, fakeProcessor, glbBytes, jpegBytes, json, reader, SECRET, seedTour, setup } from "./helpers.ts";

function upload(bytes: Uint8Array<ArrayBuffer>, type: string, headers: Record<string, string> = editor): RequestInit {
  return { method: "POST", headers: { "content-type": type, ...headers }, body: bytes };
}

async function assets(app: any, tourId: string) {
  return (await call(app, `/tours/${tourId}/assets`, { headers: reader })).body.assets;
}

describe("uploads and processing", () => {
  test("a panorama upload is queued, tiled by the processor and becomes ready", async () => {
    const proc = fakeProcessor();
    const { app, q, store } = setup({ processors: [proc] });
    const { tour, s1 } = await seedTour(app);
    const r = await call(app, `/tours/${tour.id}/scenes/${s1.id}/upload`, upload(jpegBytes(), "image/jpeg"));
    expect(r.status).toBe(202);
    expect(r.body.asset).toMatchObject({ status: "queued", kind: "pano", contentType: "image/jpeg", sceneId: s1.id });
    expect(r.body.asset.sourceKey.startsWith(`tours/${tour.id}/src/`)).toBe(true);
    await q.drain();
    const [a] = await assets(app, tour.id);
    expect(a).toMatchObject({ status: "ready", progress: 1, error: null, processor: "fake", attempts: 1 });
    expect(a.output).toMatchObject({ layout: "cube", prefix: `tours/${tour.id}/out/${a.id}/r1`, levels: [{ size: 512 }] });
    expect(await store.head(`tours/${tour.id}/out/${a.id}/r1/0/f/0_0.jpg`)).not.toBeNull();
    expect(proc.calls).toEqual([`pano:${a.id}`]);
    const detail = await call(app, `/tours/${tour.id}`, { headers: reader });
    expect(detail.body.scenes[0].asset).toMatchObject({ id: a.id, status: "ready" });
  });

  test("a model upload is optimized", async () => {
    const { app, q } = setup();
    const { tour } = await seedTour(app);
    const m = (await call(app, `/tours/${tour.id}/scenes`, json("POST", { title: "Sofa", type: "model3d" }, editor))).body;
    const r = await call(app, `/tours/${tour.id}/scenes/${m.id}/upload`, upload(glbBytes(), "model/gltf-binary"));
    expect(r.status).toBe(202);
    await q.drain();
    const [a] = await assets(app, tour.id);
    expect(a).toMatchObject({ kind: "model", status: "ready", output: { layout: "glb" } });
  });

  test("image scenes need no processing", async () => {
    const proc = fakeProcessor();
    const { app } = setup({ processors: [proc] });
    const { tour } = await seedTour(app);
    const img = (await call(app, `/tours/${tour.id}/scenes`, json("POST", { title: "Plan", type: "image" }, editor))).body;
    const r = await call(app, `/tours/${tour.id}/scenes/${img.id}/upload`, upload(jpegBytes(), "image/jpeg"));
    expect(r.status).toBe(201);
    expect(r.body.asset).toMatchObject({ status: "ready", progress: 1 });
    expect(proc.calls).toEqual([]);
  });

  test("the file's bytes must match the scene type", async () => {
    const { app } = setup();
    const { tour, s1 } = await seedTour(app);
    const r = await call(app, `/tours/${tour.id}/scenes/${s1.id}/upload`, upload(glbBytes(), "image/jpeg"));
    expect(r.status).toBe(415);
    expect(await assets(app, tour.id)).toEqual([]);
  });

  test("uploading needs tours:write", async () => {
    const { app } = setup();
    const { tour, s1 } = await seedTour(app);
    expect((await call(app, `/tours/${tour.id}/scenes/${s1.id}/upload`, upload(jpegBytes(), "image/jpeg", reader))).status).toBe(403);
  });

  test("transient failures are retried; progress and attempts are recorded", async () => {
    const proc = fakeProcessor({ fail: 2 });
    const { app, q } = setup({ processors: [proc] });
    const { tour, s1 } = await seedTour(app);
    await call(app, `/tours/${tour.id}/scenes/${s1.id}/upload`, upload(jpegBytes(), "image/jpeg"));
    await q.drain();
    const [a] = await assets(app, tour.id);
    expect(a).toMatchObject({ status: "ready", attempts: 3, error: null });
    expect(a.output.prefix.endsWith("/r3")).toBe(true);
  });

  test("an asset that fails every attempt is marked failed with the error", async () => {
    const proc = fakeProcessor({ fail: 99 });
    const { app, q } = setup({ processors: [proc] });
    const { tour, s1 } = await seedTour(app);
    await call(app, `/tours/${tour.id}/scenes/${s1.id}/upload`, upload(jpegBytes(), "image/jpeg"));
    await q.drain();
    const [a] = await assets(app, tour.id);
    expect(a).toMatchObject({ status: "failed", attempts: 4 });
    expect(a.error).toContain("transient failure");
    expect(q.deadLetters.length).toBe(1);
  });

  test("without a processor for the step, the asset fails at once with a fix", async () => {
    const { app, q } = setup({ processors: [] });
    const { tour, s1 } = await seedTour(app);
    await call(app, `/tours/${tour.id}/scenes/${s1.id}/upload`, upload(jpegBytes(), "image/jpeg"));
    await q.drain();
    const [a] = await assets(app, tour.id);
    expect(a.status).toBe("failed");
    expect(a.error).toContain("MIU_E_TOUR_PROCESSOR_MISSING");
    expect(q.deadLetters.length).toBe(0);
  });

  test("a processor result that escapes its output prefix is rejected", async () => {
    const evil = {
      name: "evil",
      async tilePanorama() {
        return { layout: "cube" as const, prefix: "someone-else", ext: "jpg" as const, tileSize: 512, faceSize: 512, levels: [{ size: 512 }] };
      },
    };
    const { app, q } = setup({ processors: [evil] });
    const { tour, s1 } = await seedTour(app);
    await call(app, `/tours/${tour.id}/scenes/${s1.id}/upload`, upload(jpegBytes(), "image/jpeg"));
    await q.drain();
    const [a] = await assets(app, tour.id);
    expect(a.status).toBe("failed");
    expect(a.error).toContain("MIU_E_TOUR_PROCESSOR_RESULT_INVALID");
  });

  test("a processor cannot write outside its output prefix", async () => {
    const sneaky = {
      name: "sneaky",
      async tilePanorama(ctx: any) {
        await ctx.write(`tours/other/secret.jpg`, new Uint8Array([1]));
        return { layout: "equirect" as const, sources: [{ width: 1, url: "https://cdn.example.com/x.jpg" }] };
      },
    };
    const { app, q, store } = setup({ processors: [sneaky] });
    const { tour, s1 } = await seedTour(app);
    await call(app, `/tours/${tour.id}/scenes/${s1.id}/upload`, upload(jpegBytes(), "image/jpeg"));
    await q.drain();
    expect((await assets(app, tour.id))[0].status).toBe("failed");
    expect(await store.head("tours/other/secret.jpg")).toBeNull();
  });

  test("retry re-queues a failed asset", async () => {
    const proc = fakeProcessor({ fail: 4 });
    const { app, q } = setup({ processors: [proc] });
    const { tour, s1 } = await seedTour(app);
    await call(app, `/tours/${tour.id}/scenes/${s1.id}/upload`, upload(jpegBytes(), "image/jpeg"));
    await q.drain();
    const [failed] = await assets(app, tour.id);
    expect(failed.status).toBe("failed");
    const r = await call(app, `/tours/${tour.id}/assets/${failed.id}/retry`, { method: "POST", headers: editor });
    expect(r.status).toBe(202);
    expect(r.body.asset.status).toBe("queued");
    await q.drain();
    expect((await assets(app, tour.id))[0]).toMatchObject({ status: "ready", attempts: 5 });
  });

  test("attach a file uploaded with multipart uploads by its key", async () => {
    const { app, q, store } = setup();
    const { tour, s1 } = await seedTour(app);
    await store.put("uploads/big.jpg", new Blob([jpegBytes(128) as BlobPart]).stream(), { contentType: "image/jpeg" });
    await store.put("uploads/model.glb", new Blob([glbBytes() as BlobPart]).stream(), { contentType: "model/gltf-binary" });
    expect((await call(app, `/tours/${tour.id}/scenes/${s1.id}/asset`, json("PUT", { key: "uploads/missing.jpg" }, editor))).body.error.code).toBe("MIU_E_TOUR_SOURCE_MISSING");
    expect((await call(app, `/tours/${tour.id}/scenes/${s1.id}/asset`, json("PUT", { key: "uploads/model.glb" }, editor))).status).toBe(415);
    expect((await call(app, `/tours/${tour.id}/scenes/${s1.id}/asset`, json("PUT", { key: "../x" }, editor))).status).toBe(400);
    const r = await call(app, `/tours/${tour.id}/scenes/${s1.id}/asset`, json("PUT", { key: "uploads/big.jpg" }, editor));
    expect(r.status).toBe(202);
    expect(r.body.asset).toMatchObject({ sourceKey: "uploads/big.jpg", size: 128, kind: "pano" });
    await q.drain();
    expect((await assets(app, tour.id))[0].status).toBe("ready");
  });
});

describe("wiring errors", () => {
  test("uploads without a queue plugin fail before storing anything", async () => {
    const { app, store } = setup({ withQueue: false });
    const { tour, s1 } = await seedTour(app);
    const r = await call(app, `/tours/${tour.id}/scenes/${s1.id}/upload`, upload(jpegBytes(), "image/jpeg"));
    expect(r.status).toBe(500);
    expect(r.body.error.code).toBe("MIU_E_TOUR_QUEUE_MISSING");
    expect((await store.list()).files).toEqual([]);
  });

  test("a queue that does not run the tour jobs is caught at startup", async () => {
    const other = defineJob("other", { input: t.object({}), run: () => {} });
    const plugin = tour({ database: sqlite(":memory:"), secret: SECRET });
    const app = miu({ plugins: [fakeAccess(), files({ store: memoryStore(), secret: SECRET }), queue({ adapter: memoryQueue(), jobs: [other] }), plugin], logLevel: "silent" });
    let code = "";
    await app.ready().catch((e) => (code = e.code));
    expect(code).toBe("MIU_E_TOUR_JOBS_NOT_REGISTERED");
  });

  test("uploads without @miujs/files explain what to add", async () => {
    const { app } = setup({ withFiles: false });
    const { tour, s1 } = await seedTour(app);
    const r = await call(app, `/tours/${tour.id}/scenes/${s1.id}/upload`, upload(jpegBytes(), "image/jpeg"));
    expect(r.body.error.code).toBe("MIU_E_TOUR_FILES_MISSING");
  });
});
