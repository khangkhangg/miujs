import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localStore, memoryStore, r2Store, type FileStore } from "../src/index.ts";
import { collect } from "../src/stream.ts";
import { fakeR2 } from "./fake-r2.ts";
import { samples, str, text } from "./fixtures.ts";
import { errorCode, makeApp } from "./helpers.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const asUser = (id: string, extra: Record<string, string> = {}) => ({ "x-test-user": id, ...extra });
const json = (body: unknown, user = "u1"): RequestInit => ({ method: "POST", body: JSON.stringify(body), headers: asUser(user, { "content-type": "application/json" }) });

function setup(opts: Parameters<typeof makeApp>[0] = {}, env?: Record<string, unknown>) {
  const t = makeApp(opts);
  const req = (url: string, init: RequestInit = {}) => t.req(url, init, env);
  const create = async (body: unknown = { filename: "house.glb", contentType: "model/gltf-binary" }, user = "u1") => req("/_files/uploads", json(body, user));
  const part = (id: string, n: number | string, body: BodyInit, user = "u1") => req(`/_files/uploads/${id}/parts/${n}`, { method: "PUT", body, headers: asUser(user) });
  const complete = (id: string, parts: unknown, user = "u1") => req(`/_files/uploads/${id}/complete`, json({ parts }, user));
  const abort = (id: string, user = "u1") => req(`/_files/uploads/${id}`, { method: "DELETE", headers: asUser(user) });
  return { ...t, req, create, part, complete, abort };
}

const glb = (rest: string) => {
  const out = new Uint8Array(samples.glb.length + rest.length);
  out.set(samples.glb);
  out.set(text(rest), samples.glb.length);
  return out;
};

const stores: [string, () => { store: FileStore; env?: Record<string, unknown> }][] = [
  ["memory", () => ({ store: memoryStore() })],
  [
    "local",
    () => {
      const d = mkdtempSync(join(tmpdir(), "miu-files-mp-"));
      dirs.push(d);
      return { store: localStore(d) };
    },
  ],
  ["r2", () => ({ store: r2Store("FILES"), env: { FILES: fakeR2() } })],
];

describe.each(stores)("resumable multipart upload (%s)", (_, make) => {
  test("create, upload parts in any order, complete, then download", async () => {
    const { store, env } = make();
    const t = setup({ store }, env);
    const res = await t.create();
    expect(res.status).toBe(201);
    const { uploadId, key, expiresAt } = (await res.json()) as any;
    expect(key).toMatch(/^uploads\/[0-9a-f]{32}\.glb$/);
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());

    const bytes = glb("-the-rest-of-the-model");
    const p2 = (await (await t.part(uploadId, 2, bytes.slice(10))).json()) as any;
    const p1res = await t.part(uploadId, 1, bytes.slice(0, 10));
    expect(p1res.status).toBe(200);
    const p1 = (await p1res.json()) as any;
    // (Not toMatchObject with expect.any: Bun 1.4.3 writes the matcher into the received object.)
    expect(p1.partNumber).toBe(1);
    expect(typeof p1.etag).toBe("string");

    const done = await t.complete(uploadId, [p1, p2]);
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ key, size: bytes.length, contentType: "model/gltf-binary" });

    const url = await t.inCtx(({ files }) => files.signedUrl(key), env ? { env } : {});
    const dl = await t.req(new URL(url).pathname, { headers: { range: "bytes=0-3" } });
    expect(dl.status).toBe(206);
    expect(await dl.text()).toBe("glTF");
  });
});

describe("multipart security and limits", () => {
  test("creating an upload requires a signed-in user", async () => {
    const t = setup();
    const res = await t.req("/_files/uploads", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(401);
  });

  test("another user cannot touch the upload", async () => {
    const t = setup();
    const { uploadId } = (await (await t.create()).json()) as any;
    const p1 = (await (await t.part(uploadId, 1, glb("x"))).json()) as any;
    for (const res of [await t.part(uploadId, 2, "x", "mallory"), await t.complete(uploadId, [p1], "mallory"), await t.abort(uploadId, "mallory")]) {
      expect(res.status).toBe(403);
      expect(await errorCode(res)).toBe("MIU_E_FILES_TOKEN_INVALID");
    }
    expect((await t.complete(uploadId, [p1])).status).toBe(200);
  });

  test("a tampered upload id is refused", async () => {
    const t = setup();
    const { uploadId } = (await (await t.create()).json()) as any;
    const [body, sig] = uploadId.split(".");
    const payload = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/")));
    payload.k = "someone-else/model.glb";
    const forged = btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") + "." + sig;
    expect((await t.part(forged, 1, "x")).status).toBe(403);
  });

  test("a signed download URL is not an upload id", async () => {
    const t = setup();
    const url = await t.inCtx(({ files }) => files.signedUrl("a"));
    const token = url.split("/").pop()!;
    expect((await t.part(token, 1, "x")).status).toBe(403);
  });

  test("an expired upload id is refused", async () => {
    const t = setup({ multipart: { expiresIn: 60 } });
    const { uploadId } = (await (await t.create()).json()) as any;
    const realNow = Date.now;
    Date.now = () => realNow() + 120_000;
    try {
      const res = await t.part(uploadId, 1, "x");
      expect(res.status).toBe(403);
      expect(await errorCode(res)).toBe("MIU_E_FILES_TOKEN_EXPIRED");
    } finally {
      Date.now = realNow;
    }
  });

  test.each(["0", "10001", "abc", "1.5", "-1"])("part number %p is rejected", async (n) => {
    const t = setup();
    const { uploadId } = (await (await t.create()).json()) as any;
    const res = await t.part(uploadId, n, "x");
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("MIU_E_FILES_PART_INVALID");
  });

  test("a part over maxPartSize is 413, streamed", async () => {
    const t = setup({ multipart: { maxPartSize: 8 } });
    const { uploadId } = (await (await t.create()).json()) as any;
    const res = await t.part(uploadId, 1, new ReadableStream({ pull: (c) => c.enqueue(new Uint8Array(4)) }) as any);
    expect(res.status).toBe(413);
  });

  test("a finished file over maxSize is deleted and refused", async () => {
    const t = setup({ multipart: { maxSize: 16 } });
    const { uploadId, key } = (await (await t.create()).json()) as any;
    const p1 = (await (await t.part(uploadId, 1, glb("0123456789"))).json()) as any;
    const res = await t.complete(uploadId, [p1]);
    expect(res.status).toBe(413);
    expect(await t.store.head(key)).toBeNull();
  });

  test("allowedTypes: the declared type must be allowed and the bytes must match it", async () => {
    const t = setup({ multipart: { allowedTypes: ["glb", "mp4"] } });
    expect((await t.create({ filename: "x.glb" })).status).toBe(415);
    expect((await t.create({ filename: "x.html", contentType: "text/html" })).status).toBe(415);

    const { uploadId, key } = (await (await t.create({ filename: "x.mp4", contentType: "video/mp4" })).json()) as any;
    expect(key).toEndWith(".mp4");
    const p1 = (await (await t.part(uploadId, 1, glb("not a video"))).json()) as any;
    const res = await t.complete(uploadId, [p1]);
    expect(res.status).toBe(415);
    expect(await errorCode(res)).toBe("MIU_E_FILES_TYPE_NOT_ALLOWED");
    expect(await t.store.head(key)).toBeNull();

    const ok = (await (await t.create()).json()) as any;
    const q1 = (await (await t.part(ok.uploadId, 1, glb("model"))).json()) as any;
    expect((await t.complete(ok.uploadId, [q1])).status).toBe(200);
  });

  test("abort discards the upload", async () => {
    const t = setup();
    const { uploadId } = (await (await t.create()).json()) as any;
    await t.part(uploadId, 1, "x");
    expect((await t.abort(uploadId)).status).toBe(204);
    const res = await t.part(uploadId, 2, "y");
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("MIU_E_FILES_UPLOAD_NOT_FOUND");
  });

  test.each([["missing", undefined], ["empty", []], ["no etag", [{ partNumber: 1 }]], ["string partNumber", [{ partNumber: "1", etag: "x" }]], ["not an array", "nope"], ["duplicate", [{ partNumber: 1, etag: "a" }, { partNumber: 1, etag: "a" }]]] as [string, unknown][])("complete with parts %s is 400", async (_, parts) => {
    const t = setup();
    const { uploadId } = (await (await t.create()).json()) as any;
    await t.part(uploadId, 1, "x");
    const res = await t.complete(uploadId, parts);
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("MIU_E_FILES_PART_INVALID");
  });

  test("create validates its body", async () => {
    const t = setup();
    expect((await t.req("/_files/uploads", { method: "POST", body: "{not json", headers: asUser("u1", { "content-type": "application/json" }) })).status).toBe(400);
    expect((await t.create({ filename: 42 })).status).toBe(400);
    expect((await t.create({ contentType: "text/plain\r\nx: y" })).status).toBe(400);
  });

  test("the key option chooses where the upload goes; it is validated", async () => {
    const t = setup({ multipart: { key: (ctx, f) => (f.filename === "bad.glb" ? "../bad.glb" : `tours/${ctx.user!.id}/${f.filename}`) } });
    const { key } = (await (await t.create({ filename: "lobby.glb", contentType: "model/gltf-binary" })).json()) as any;
    expect(key).toBe("tours/u1/lobby.glb");
    const res = await t.create({ filename: "bad.glb" });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("MIU_E_FILES_KEY_INVALID");
  });

  test("multipart: false removes the routes", async () => {
    const t = setup({ multipart: false });
    expect([404, 405]).toContain((await t.create()).status);
  });

  test("the stored file records who uploaded it and the cleaned file name", async () => {
    const t = setup();
    const { uploadId, key } = (await (await t.create({ filename: "a/b/Nhà mẫu.glb", contentType: "model/gltf-binary" })).json()) as any;
    const p1 = (await (await t.part(uploadId, 1, glb("x"))).json()) as any;
    await t.complete(uploadId, [p1]);
    expect((await t.store.head(key))!.metadata).toEqual({ filename: "Nhà mẫu.glb", uploadedBy: "u1" });
    expect(str(await collect((await t.store.get(key))!.body)).startsWith("glTF")).toBe(true);
  });
});
