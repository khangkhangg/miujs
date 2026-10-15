import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createLogger } from "miujs";
import { memoryStore } from "@miujs/files";
import { cloudflareImagesProcessor, gltfTransformProcessor, vipsProcessor, type Exec, type ProcessorContext } from "../src/index.ts";
import { glbBytes, jpegBytes } from "./helpers.ts";

async function ctxFor(kind: "pano" | "model", bytes: Uint8Array) {
  const store = memoryStore();
  const sourceKey = kind === "pano" ? "tours/t1/src/a.jpg" : "tours/t1/src/a.glb";
  await store.put(sourceKey, new Blob([bytes as BlobPart]).stream(), { contentType: kind === "pano" ? "image/jpeg" : "model/gltf-binary" });
  const progress: number[] = [];
  const outputPrefix = "tours/t1/out/ast_1/r1";
  const ctx: ProcessorContext = {
    asset: { id: "ast_1", tourId: "t1", sceneId: "s1", kind, sourceKey, contentType: "image/jpeg", size: bytes.byteLength, status: "processing", progress: 0, error: null, output: null, processor: null, attempts: 1, createdAt: 0, updatedAt: 0 },
    tour: { id: "t1", slug: "t" },
    outputPrefix,
    store,
    read: async (k) => new Uint8Array(await new Response((await store.get(k))!.body).arrayBuffer()),
    stream: async (k) => (await store.get(k))!.body,
    write: async (k, body, contentType) => void (await store.put(k, typeof body === "string" || body instanceof Uint8Array ? new Blob([body as BlobPart]).stream() : body, { contentType })),
    progress: async (p) => void progress.push(p),
    callbackUrl: null,
    attempt: 1,
    env: {},
    log: createLogger("silent" as any),
  };
  return { ctx, store, progress };
}

const notFound: Exec = async (cmd) => {
  const e = new Error(`spawn ${cmd[0]} ENOENT`) as Error & { code: string };
  e.code = "ENOENT";
  throw e;
};

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "no error";
  } catch (e: any) {
    return e.code ?? e.message;
  }
}

describe("vipsProcessor", () => {
  test("builds an equirectangular tile pyramid with the vips CLI and uploads it", async () => {
    const calls: string[][] = [];
    // Stand-in for vips: answers vipsheader and writes the files vips would write.
    const exec: Exec = async (cmd) => {
      calls.push(cmd);
      if (cmd[0] === "vipsheader") return { code: 0, stdout: cmd[2] === "width" ? "5000\n" : "2500\n", stderr: "" };
      if (cmd[1] === "thumbnail") {
        await mkdir(dirname(cmd[3]), { recursive: true });
        await writeFile(cmd[3], "img");
      }
      if (cmd[1] === "dzsave") {
        const out = cmd[3];
        const w = Number(/-(\d+)\.jpg$/.exec(cmd[2])?.[1] ?? 0);
        for (let y = 0; y < w / 2 / 512; y++) for (let x = 0; x < w / 512; x++) {
          await mkdir(join(out, "0", String(y)), { recursive: true });
          await writeFile(join(out, "0", String(y), `${x}.jpg`), "t");
        }
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const { ctx, store, progress } = await ctxFor("pano", jpegBytes());
    const r = await vipsProcessor({ exec }).tilePanorama!(ctx);
    expect(r).toEqual({
      layout: "equirect-tiles",
      prefix: "tours/t1/out/ast_1/r1",
      ext: "jpg",
      tileSize: 512,
      levels: [
        { width: 1024, cols: 2, rows: 1 },
        { width: 2048, cols: 4, rows: 2 },
        { width: 4096, cols: 8, rows: 4 },
      ],
      preview: "tours/t1/out/ast_1/r1/preview.jpg",
    });
    expect(await store.head("tours/t1/out/ast_1/r1/2/3_7.jpg")).not.toBeNull();
    expect(await store.head("tours/t1/out/ast_1/r1/0/0_1.jpg")).not.toBeNull();
    expect(await store.head("tours/t1/out/ast_1/r1/preview.jpg")).not.toBeNull();
    const dz = calls.find((c) => c[1] === "dzsave")!;
    expect(dz).toContain("--layout");
    expect(dz).toContain("google");
    expect(progress.at(-1)).toBeGreaterThan(0.9);
  });

  test("without vips the asset fails with a fix instead of retrying", async () => {
    const { ctx } = await ctxFor("pano", jpegBytes());
    expect(await code(vipsProcessor({ exec: notFound }).tilePanorama!(ctx))).toBe("MIU_E_TOUR_PROCESSOR_UNAVAILABLE");
  });

  test("a vips error carries its stderr", async () => {
    const { ctx } = await ctxFor("pano", jpegBytes());
    const exec: Exec = async (cmd) => (cmd[0] === "vipsheader" ? { code: 0, stdout: "4096", stderr: "" } : { code: 1, stdout: "", stderr: "VipsJpeg: Premature end of input file" });
    let msg = "";
    await vipsProcessor({ exec }).tilePanorama!(ctx).catch((e) => (msg = e.message));
    expect(msg).toContain("Premature end");
  });
});

describe("gltfTransformProcessor", () => {
  test("runs gltf-transform optimize with Draco and KTX2 by default", async () => {
    const calls: string[][] = [];
    const exec: Exec = async (cmd) => {
      calls.push(cmd);
      const out = cmd[cmd.indexOf("optimize") + 2];
      await writeFile(out, glbBytes(32));
      return { code: 0, stdout: "", stderr: "" };
    };
    const { ctx, store } = await ctxFor("model", glbBytes(64));
    const r = await gltfTransformProcessor({ exec }).optimizeModel!(ctx);
    expect(r).toEqual({ layout: "glb", key: "tours/t1/out/ast_1/r1/model.glb", bytes: 32, originalBytes: 64, requires: ["draco", "ktx2"] });
    expect(calls[0].slice(0, 4)).toEqual(["npx", "--yes", "@gltf-transform/cli@4.5.0", "optimize"]);
    expect(calls[0]).toContain("--compress");
    expect(calls[0][calls[0].indexOf("--compress") + 1]).toBe("draco");
    expect(calls[0][calls[0].indexOf("--texture-compress") + 1]).toBe("ktx2");
    expect((await store.head("tours/t1/out/ast_1/r1/model.glb"))?.contentType).toBe("model/gltf-binary");
  });

  test("meshopt and webp are options; unavailable npx is a clear error", async () => {
    const calls: string[][] = [];
    const exec: Exec = async (cmd) => {
      calls.push(cmd);
      await writeFile(cmd[cmd.indexOf("optimize") + 2], glbBytes(16));
      return { code: 0, stdout: "", stderr: "" };
    };
    const { ctx } = await ctxFor("model", glbBytes(64));
    const r = await gltfTransformProcessor({ exec, compress: "meshopt", textures: "webp" }).optimizeModel!(ctx);
    expect((r as any).requires).toEqual(["meshopt"]);
    expect(calls[0][calls[0].indexOf("--texture-compress") + 1]).toBe("webp");
    expect(await code(gltfTransformProcessor({ exec: notFound }).optimizeModel!(ctx))).toBe("MIU_E_TOUR_PROCESSOR_UNAVAILABLE");
  });
});

describe("cloudflareImagesProcessor", () => {
  test("uploads the panorama and returns flexible-variant URLs by width", async () => {
    const seen: { url: string; auth: string | null; form: FormData }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, auth: new Headers(init.headers).get("authorization"), form: init.body as FormData });
      return Response.json({ success: true, result: { id: "img123", variants: ["https://imagedelivery.net/HASH/img123/public"] } });
    }) as unknown as typeof globalThis.fetch;
    const { ctx } = await ctxFor("pano", jpegBytes());
    const r = await cloudflareImagesProcessor({ accountId: "acc", token: "tok", fetch, widths: [2048, 4096] }).tilePanorama!(ctx);
    expect(seen[0].url).toBe("https://api.cloudflare.com/client/v4/accounts/acc/images/v1");
    expect(seen[0].auth).toBe("Bearer tok");
    expect(seen[0].form.get("file")).toBeInstanceOf(Blob);
    expect(seen[0].form.get("id")).toBe("tour-ast_1-r1");
    expect(r).toEqual({
      layout: "equirect",
      sources: [
        { width: 2048, url: "https://imagedelivery.net/HASH/img123/w=2048" },
        { width: 4096, url: "https://imagedelivery.net/HASH/img123/w=4096" },
      ],
    });
  });

  test("API errors become processor failures; models are not supported", async () => {
    const fetch = (async () => Response.json({ success: false, errors: [{ code: 5400, message: "Image too large" }] }, { status: 400 })) as unknown as typeof globalThis.fetch;
    const p = cloudflareImagesProcessor({ accountId: "acc", token: "tok", fetch });
    const { ctx } = await ctxFor("pano", jpegBytes());
    let err: any;
    await p.tilePanorama!(ctx).catch((e) => (err = e));
    expect(err.code).toBe("MIU_E_TOUR_PROCESSOR_FAILED");
    expect(err.message).toContain("Image too large");
    expect(p.optimizeModel).toBeUndefined();
  });

  test("inspect never shows the token", () => {
    expect(JSON.stringify(cloudflareImagesProcessor({ accountId: "acc", token: "secret-token" }).inspect!())).not.toContain("secret-token");
  });
});
