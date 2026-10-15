// files().manage(): store, usage and files for operators.
import { describe, expect, test } from "bun:test";
import { validate, type ManageAction, type ManageList } from "miujs";
import { memoryStore } from "../src/memory.ts";
import { makeApp, SECRET } from "./helpers.ts";
import { fakeS3 } from "./fake-s3.ts";
import { s3Store } from "../src/s3.ts";

const MiB = 1024 * 1024;

async function setup(opts: Parameters<typeof makeApp>[0] = {}) {
  const made = makeApp(opts);
  await made.app.ready();
  const sections = made.plugin.manage!();
  const section = sections.find((s) => s.id === "files")!;
  return { ...made, sections, section };
}
type S = Awaited<ReturnType<typeof setup>>;

const list = (s: S) => s.section.lists!.find((l) => l.name === "files")!;
const rowAction = (l: ManageList, name: string) => l.rowActions!.find((a) => a.name === name)!;
async function run(s: S, a: ManageAction, input: Record<string, unknown>) {
  const v = validate(a.input!, input);
  if (!v.ok) throw new Error(`invalid input: ${JSON.stringify(v.issues)}`);
  return s.inCtx((ctx) => a.run(v.value, ctx));
}
async function put(s: S, key: string, text: string, contentType = "text/plain") {
  await s.inCtx((ctx) => ctx.files.put(key, text, { contentType }));
}

describe("files manage()", () => {
  test("one 'files' section; names are well-formed", async () => {
    const s = await setup();
    expect(s.sections.map((x) => x.id)).toEqual(["files"]);
    for (const l of s.section.lists!) for (const a of [l, ...(l.rowActions ?? [])]) expect(a.name).toMatch(/^[a-z][a-zA-Z0-9_]*$/);
  });

  test("status: store kind, file count and bytes, limits; never the signing secret", async () => {
    const s = await setup();
    await put(s, "a/one.txt", "hello");
    await put(s, "b/two.txt", "world!!");
    const st = await s.inCtx((ctx) => s.section.status!(ctx));
    const v = (label: string) => st.stats!.find((x) => x.label === label);
    expect(v("Store")!.value).toBe("memory");
    expect(v("Files")!.value).toBe(2);
    expect(v("Size")!.value).toBe(12);
    expect(v("Max upload size")!.value).toBe(100 * MiB);
    expect(v("Signing secret")!.value).toBe("set");
    expect(JSON.stringify(st)).not.toContain(SECRET);
  });

  test("status counts at most one page of files and says so", async () => {
    const s = await setup();
    await s.inCtx(async (ctx) => {
      for (let i = 0; i < 1001; i++) await ctx.files.put(`f/${String(i).padStart(4, "0")}`, "x");
    });
    const st = await s.inCtx((ctx) => s.section.status!(ctx));
    const files = st.stats!.find((x) => x.label === "Files")!;
    expect(files.value).toBe("1000+");
    expect(files.hint).toContain("first 1000");
  });

  test("status hides credentials from the store's details (S3 keys)", async () => {
    const creds = { accessKeyId: "AKIAEXAMPLEKEY", secretAccessKey: "very-secret-access-key" };
    const server = fakeS3({ ...creds, region: "us-east-1" });
    server.createBucket("b");
    const s = await setup({ store: s3Store({ bucket: "b", region: "us-east-1", endpoint: server.url, ...creds, forcePathStyle: true }) });
    await put(s, "k.txt", "hi");
    const st = await s.inCtx((ctx) => s.section.status!(ctx));
    const rows = await s.inCtx((ctx) => list(s).list({ limit: 10 }, ctx));
    server.stop();
    expect(st.stats!.find((x) => x.label === "Files")!.value).toBe(1);
    const dump = JSON.stringify([st, rows]);
    expect(dump).not.toContain("very-secret-access-key");
    expect(dump).not.toContain("AKIAEXAMPLEKEY");
    expect(st.stats!.find((x) => x.label === "Store")!.value).toBe("s3");
  });

  test("files list pages by key with a prefix search", async () => {
    const s = await setup();
    for (const k of ["a/1.txt", "a/2.txt", "a/3.txt", "b/1.txt"]) await put(s, k, "data");
    const l = list(s);
    expect(l.idKey).toBe("key");
    expect(l.searchable).toBe(true);
    const p1 = await s.inCtx((ctx) => l.list({ limit: 2, search: "a/" }, ctx));
    expect(p1.rows).toEqual([
      { key: "a/1.txt", size: 4, contentType: "text/plain", uploaded: expect.any(Number) },
      { key: "a/2.txt", size: 4, contentType: "text/plain", uploaded: expect.any(Number) },
    ]);
    const p2 = await s.inCtx((ctx) => l.list({ limit: 2, search: "a/", cursor: p1.next }, ctx));
    expect(p2.rows.map((r) => r.key)).toEqual(["a/3.txt"]);
    expect(p2.next).toBeUndefined();
    const all = await s.inCtx((ctx) => l.list({ limit: 100 }, ctx));
    expect(all.rows).toHaveLength(4);
  });

  test("delete removes a file (danger) and is idempotent", async () => {
    const s = await setup();
    await put(s, "a/1.txt", "data");
    const a = rowAction(list(s), "delete");
    expect(a.danger).toBe(true);
    expect(await run(s, a, { key: "a/1.txt" })).toBe("Deleted a/1.txt");
    expect(await s.inCtx((ctx) => ctx.files.head("a/1.txt"))).toBeNull();
    expect(await run(s, a, { key: "a/1.txt" })).toBe("a/1.txt was already gone");
    await expect(run(s, a, { key: "../etc/passwd" })).rejects.toMatchObject({ code: "MIU_E_FILES_KEY_INVALID" });
  });

  test("downloadLink returns a short-lived signed URL that works, without the secret", async () => {
    const s = await setup();
    await put(s, "docs/report.txt", "the report");
    const a = rowAction(list(s), "downloadLink");
    expect(validate(a.input!, { key: "docs/report.txt", expiresIn: 0 }).ok).toBe(false);
    expect(validate(a.input!, { key: "docs/report.txt", expiresIn: 86_400 }).ok).toBe(false);
    const out = (await run(s, a, { key: "docs/report.txt", expiresIn: 120 })) as { url: string; expiresAt: string };
    expect(out.url).toStartWith("http://app.test/_files/");
    expect(out.url).not.toContain(SECRET);
    expect(Date.parse(out.expiresAt) - Date.now()).toBeLessThanOrEqual(120_000);
    const res = await s.req(out.url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("the report");
    expect(res.headers.get("content-disposition")).toContain("report.txt");
    await expect(run(s, a, { key: "missing.txt" })).rejects.toMatchObject({ code: "MIU_E_FILES_NOT_FOUND" });
  });

  test("settings: maxUploadSize is the effective limit for signed PUT uploads and applies now", async () => {
    const s = await setup({ maxUploadSize: 10 });
    const settings = s.section.settings!;
    expect(await s.inCtx((ctx) => settings.get(ctx))).toEqual({ maxUploadSize: 10 });
    for (const bad of [{ maxUploadSize: 0 }, { maxUploadSize: 1.5 }, { maxUploadSize: "10" }, {}]) expect(validate(settings.schema, bad).ok).toBe(false);
    const url = await s.inCtx((ctx) => ctx.files.signedUrl("up/x.bin", { method: "PUT" }));
    const putBytes = (n: number) => s.req(url, { method: "PUT", body: new Uint8Array(n), headers: { "content-length": String(n) } });
    expect((await putBytes(20)).status).toBe(413);
    await s.inCtx((ctx) => settings.set({ maxUploadSize: 100 }, ctx));
    expect(await s.inCtx((ctx) => settings.get(ctx))).toEqual({ maxUploadSize: 100 });
    expect((await putBytes(20)).status).toBe(200);
    const st = await s.inCtx((ctx) => s.section.status!(ctx));
    expect(st.stats!.find((x) => x.label === "Max upload size")!.value).toBe(100);
  });

  test("a custom store's inspect() keys that look secret are never shown", async () => {
    const base = memoryStore();
    const s = await setup({ store: { ...base, kind: "custom", inspect: () => ({ bucket: "media", apiKey: "leak-1", secretToken: "leak-2", nested: { password: "leak-3" } }) } });
    const st = await s.inCtx((ctx) => s.section.status!(ctx));
    expect(st.stats!.find((x) => x.label === "Store bucket")!.value).toBe("media");
    expect(JSON.stringify(st)).not.toMatch(/leak-/);
  });

  test("works with a memory store passed in explicitly", async () => {
    const s = await setup({ store: memoryStore() });
    expect((await s.inCtx((ctx) => s.section.status!(ctx))).stats!.find((x) => x.label === "Files")!.value).toBe(0);
  });
});
