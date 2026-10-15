import { describe, expect, test } from "bun:test";
import { externalProcessor, signProcessorBody, verifyProcessorSignature } from "../src/index.ts";
import { call, editor, jpegBytes, json, reader, seedTour, setup } from "./helpers.ts";

const PSECRET = "p".repeat(40);

function fakeRemote(status = 202) {
  const sent: { url: string; headers: Headers; body: string }[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), headers: new Headers(init?.headers), body: String(init?.body) });
    return new Response(status < 300 ? '{"accepted":true}' : "boom", { status });
  };
  return { sent, fetch: fetch as typeof globalThis.fetch };
}

async function signed(app: any, body: unknown, secret = PSECRET, t?: number) {
  const text = JSON.stringify(body);
  return call(app, "/tours/_processor/callback", { method: "POST", headers: { "content-type": "application/json", "x-miu-tour-signature": await signProcessorBody(secret, text, t) }, body: text });
}

async function started(status = 202) {
  const remote = fakeRemote(status);
  const proc = externalProcessor({ url: "https://worker.example.com/jobs", secret: PSECRET, fetch: remote.fetch });
  const ctx = setup({ processors: [proc] });
  const seeded = await seedTour(ctx.app);
  await call(ctx.app, `/tours/${seeded.tour.id}/scenes/${seeded.s1.id}/upload`, { method: "POST", headers: { "content-type": "image/jpeg", ...editor }, body: jpegBytes() });
  await ctx.q.drain();
  const [asset] = (await call(ctx.app, `/tours/${seeded.tour.id}/assets`, { headers: reader })).body.assets;
  return { ...ctx, ...seeded, remote, asset };
}

describe("externalProcessor", () => {
  test("POSTs a signed job and leaves the asset processing", async () => {
    const { remote, asset, tour } = await started();
    expect(remote.sent.length).toBe(1);
    const req = remote.sent[0];
    expect(req.url).toBe("https://worker.example.com/jobs");
    expect(await verifyProcessorSignature([PSECRET], req.headers.get("x-miu-tour-signature"), req.body)).toBe(true);
    const job = JSON.parse(req.body);
    expect(job).toMatchObject({
      step: "tilePanorama",
      assetId: asset.id,
      run: 1,
      tourId: tour.id,
      sourceKey: asset.sourceKey,
      contentType: "image/jpeg",
      outputPrefix: `tours/${tour.id}/out/${asset.id}/r1`,
      callbackUrl: "http://localhost/tours/_processor/callback",
    });
    expect(asset).toMatchObject({ status: "processing", processor: "external" });
  });

  test("a failing remote is retried by the queue", async () => {
    const { remote, asset } = await started(503);
    expect(remote.sent.length).toBe(4);
    expect(asset.status).toBe("failed");
    expect(asset.error).toContain("503");
  });

  test("callbacks report progress, then the result", async () => {
    const { app, asset, tour } = await started();
    expect((await signed(app, { assetId: asset.id, run: 1, status: "processing", progress: 0.4 })).status).toBe(204);
    expect((await call(app, `/tours/${tour.id}/assets`, { headers: reader })).body.assets[0]).toMatchObject({ status: "processing", progress: 0.4 });
    const prefix = `tours/${tour.id}/out/${asset.id}/r1`;
    const r = await signed(app, { assetId: asset.id, run: 1, status: "ready", result: { layout: "equirect-tiles", prefix, ext: "jpg", tileSize: 512, levels: [{ width: 2048, cols: 4, rows: 2 }] } });
    expect(r.status).toBe(204);
    const m = (await call(app, `/tours/${tour.id}/manifest.json`, { headers: reader })).body;
    expect(m.scenes[0].asset).toMatchObject({ status: "ready", layout: "equirect-tiles", levels: [{ width: 2048, cols: 4, rows: 2 }] });
    expect(m.scenes[0].asset.tiles).toContain("/{level}/{row}_{col}.jpg");
  });

  test("a failure report marks the asset failed", async () => {
    const { app, asset, tour } = await started();
    await signed(app, { assetId: asset.id, run: 1, status: "failed", error: "vips: out of memory" });
    expect((await call(app, `/tours/${tour.id}/assets`, { headers: reader })).body.assets[0]).toMatchObject({ status: "failed", error: "vips: out of memory" });
  });

  test("bad signatures, replays, stale runs and escaping results are refused", async () => {
    const { app, asset, tour } = await started();
    const bad = await signed(app, { assetId: asset.id, run: 1, status: "processing", progress: 0.5 }, "q".repeat(40));
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe("MIU_E_TOUR_CALLBACK_INVALID");
    const old = await signed(app, { assetId: asset.id, run: 1, status: "processing", progress: 0.5 }, PSECRET, Math.floor(Date.now() / 1000) - 3600);
    expect(old.status).toBe(401);
    const unsigned = await call(app, "/tours/_processor/callback", json("POST", { assetId: asset.id, run: 1, status: "processing" }));
    expect(unsigned.status).toBe(401);
    expect((await signed(app, { assetId: asset.id, run: 7, status: "processing", progress: 0.5 })).status).toBe(409);
    expect((await signed(app, { assetId: "ast_nope", run: 1, status: "processing" })).status).toBe(404);
    const escape = await signed(app, { assetId: asset.id, run: 1, status: "ready", result: { layout: "glb", key: "tours/other/x.glb" } });
    expect(escape.status).toBe(400);
    expect(escape.body.error.code).toBe("MIU_E_TOUR_PROCESSOR_RESULT_INVALID");
    expect((await call(app, `/tours/${tour.id}/assets`, { headers: reader })).body.assets[0].status).toBe("failed");
  });

  test("the callback route is not an MCP tool and hidden from inspect", async () => {
    const { app } = await started();
    await app.ready();
    expect(app.tools().map((t) => t.name)).not.toContain("tours_processor_callback");
    expect(app.inspect().routes.map((r: any) => r.path)).not.toContain("/tours/_processor/callback");
  });

  test("needs a strong secret and an https url", () => {
    expect(() => externalProcessor({ url: "https://w.example.com", secret: "short" })).toThrow(/32/);
    expect(() => externalProcessor({ url: "ftp://w.example.com", secret: PSECRET })).toThrow(/https/);
  });
});
