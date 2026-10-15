import { describe, expect, test } from "bun:test";
import { miu } from "miujs";
import { d1, sqlite } from "@miujs/db";
import { r2Store } from "@miujs/files";
import { externalProcessor, gltfTransformProcessor, tour, tourErrors, vipsProcessor } from "../src/index.ts";
import { createRuntime } from "../src/runtime.ts";
import { SECRET, setup } from "./helpers.ts";

describe("inspect()", () => {
  test("describes routes, processors, viewer, analytics and jobs without secrets", async () => {
    const { app } = setup({ processors: [externalProcessor({ url: "https://tiler.example.com/jobs", secret: "z".repeat(40) })], analytics: { perMinute: 20, retentionDays: 14 } });
    await app.ready();
    const info = app.inspect().plugins.find((p: any) => p.name === "tour")!.info as any;
    expect(info.basePath).toBe("/tours");
    expect(info.processors).toEqual([{ name: "external", steps: ["tilePanorama", "optimizeModel"], url: "https://tiler.example.com/jobs" }]);
    expect(info.viewer).toMatchObject({ assets: "cdn", versions: { psv: "5.15.1", three: "0.185.1", modelViewer: "4.3.1" } });
    expect(info.analytics).toEqual({ perMinute: 20, burst: 10, retentionDays: 14 });
    expect(info.jobs).toEqual(["tour-tile-panorama", "tour-optimize-model", "tour-aggregate-stats"]);
    expect(info.database).toEqual({ adapter: "sqlite", path: ":memory:" });
    expect(info.secret).toBe("(option)");
    expect(info.live).toBe(false);
    expect(info.processing).toContain("Workers");
    const text = JSON.stringify(info);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("z".repeat(40));
  });
});

describe("cloudflare()", () => {
  test("declares the D1, R2 and rate limit bindings it uses", () => {
    const plugin = tour({ database: d1("TOURS_DB"), store: r2Store("MEDIA"), secret: SECRET, analytics: { rateLimitBinding: "TOUR_EVENTS" } });
    expect(plugin.cloudflare()).toEqual({ d1: ["TOURS_DB"], r2: ["MEDIA"], ratelimits: [{ binding: "TOUR_EVENTS", limit: 30, period: 60 }] });
  });

  test("nothing for local backends", () => {
    expect(tour({ database: sqlite(), secret: SECRET }).cloudflare()).toEqual({});
  });

  test("CLI processors are refused when building for Workers", async () => {
    const prev = process.env.MIU_TARGET;
    process.env.MIU_TARGET = "cloudflare";
    try {
      for (const p of [vipsProcessor(), gltfTransformProcessor()]) {
        const app = miu({ plugins: [tour({ database: sqlite(), secret: SECRET, processors: [p] })], logLevel: "silent" });
        let code = "";
        await app.ready().catch((e) => (code = e.code));
        expect(code).toBe("MIU_E_TOUR_PROCESSOR_UNAVAILABLE");
      }
    } finally {
      if (prev === undefined) delete process.env.MIU_TARGET;
      else process.env.MIU_TARGET = prev;
    }
  });
});

describe("errors", () => {
  test("every tour error has a MIU_E_TOUR_ code and a fix", () => {
    const made = [
      tourErrors.notFound("x"),
      tourErrors.sceneNotFound("x"),
      tourErrors.hotspotNotFound("x"),
      tourErrors.floorPlanNotFound(1),
      tourErrors.assetNotFound("x"),
      tourErrors.slugTaken("x"),
      tourErrors.invalid("m", "Send a valid value."),
      tourErrors.tokenInvalid("x"),
      tourErrors.tokenExpired(),
      tourErrors.locked("x"),
      tourErrors.passwordWrong(),
      tourErrors.secretMissing(),
      tourErrors.secretWeak(),
      tourErrors.filesMissing(),
      tourErrors.queueMissing(),
      tourErrors.jobsNotRegistered(["a"]),
      tourErrors.processorMissing("tilePanorama"),
      tourErrors.processorUnavailable("v", "vips", "Install libvips on the worker."),
      tourErrors.processorFailed("v", "m"),
      tourErrors.resultInvalid("v", "m"),
      tourErrors.sourceMissing("k"),
      tourErrors.assetType("pano360", "glb", ["jpeg"]),
      tourErrors.callbackInvalid(),
      tourErrors.strictCdn(),
      tourErrors.liveMissing(),
      tourErrors.rateLimited(5),
      tourErrors.analyticsDisabled(),
      tourErrors.guideToken(),
      tourErrors.guideOnly(),
      tourErrors.config("CONFIG", "m", "Pass a valid option."),
    ];
    for (const e of made) {
      expect(e.code).toMatch(/^MIU_E_TOUR_[A-Z_]+$/);
      expect(e.fix).toBeString();
      expect(e.fix!.length).toBeGreaterThan(10);
    }
  });

  test("secrets: env fallbacks, weak secrets, and none in production", () => {
    const rt = createRuntime({});
    expect(rt.secrets({ TOUR_SECRET: "a".repeat(32), SESSION_SECRET: "b".repeat(32) })).toEqual(["a".repeat(32)]);
    expect(rt.secrets({ SESSION_SECRET: "b".repeat(32) })).toEqual(["b".repeat(32)]);
    expect(() => rt.secrets({ TOUR_SECRET: "short" })).toThrow(expect.objectContaining({ code: "MIU_E_TOUR_SECRET_WEAK" }));
    expect(rt.secrets({})[0].length).toBeGreaterThanOrEqual(32);
    rt.dev = false;
    expect(() => rt.secrets({})).toThrow(expect.objectContaining({ code: "MIU_E_TOUR_SECRET_MISSING" }));
  });
});
