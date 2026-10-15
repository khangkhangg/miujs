import { definePlugin, errors, miu, type Context, type MiuSocket, type Plugin } from "miujs";
import { sqlite } from "@miujs/db";
import { files, memoryStore, type FileStore } from "@miujs/files";
import { manualClock, memoryQueue, queue, type ManualClock, type MemoryQueue } from "@miujs/queue";
import { tour, type TourOptions, type TourProcessor, type PanoramaResult, type ProcessorContext } from "../src/index.ts";

export const SECRET = "x".repeat(40);

/** Test stand-in for @miujs/access: `x-perms` lists permissions, `x-org` sets the active org. */
export function fakeAccess(): Plugin {
  return definePlugin({
    name: "fake-access",
    onRequest(ctx: Context) {
      const perms = ctx.headers.get("x-perms");
      const org = ctx.headers.get("x-org");
      const list = perms ? perms.split(",") : [];
      if (perms !== null) ctx.user = { id: "u1", roles: [] };
      const c = ctx as any;
      c.org = org ? { id: org, role: "owner" } : null;
      c.can = (p: string) => list.includes(p);
      c.authorize = (p: string) => {
        if (!ctx.user) throw errors.unauthorized();
        if (!list.includes(p)) throw errors.forbidden(`Missing permission ${p}`);
      };
    },
  });
}

export const editor = { "x-perms": "tours:read,tours:write" };
export const reader = { "x-perms": "tours:read" };

/** A processor that writes tiny fake tiles to the store, so the pipeline runs without vips. */
export function fakeProcessor(opts: { fail?: number; deferred?: boolean; name?: string } = {}): TourProcessor & { calls: string[] } {
  let failures = opts.fail ?? 0;
  const calls: string[] = [];
  return {
    name: opts.name ?? "fake",
    calls,
    async tilePanorama(ctx: ProcessorContext): Promise<PanoramaResult | { deferred: true }> {
      calls.push(`pano:${ctx.asset.id}`);
      const src = await ctx.read(ctx.asset.sourceKey);
      if (failures > 0) {
        failures--;
        throw new Error("transient failure");
      }
      if (opts.deferred) return { deferred: true };
      await ctx.progress(0.5);
      for (const face of ["f", "b", "l", "r", "u", "d"]) await ctx.write(`${ctx.outputPrefix}/0/${face}/0_0.jpg`, src.slice(0, 4), "image/jpeg");
      await ctx.write(`${ctx.outputPrefix}/preview.jpg`, src.slice(0, 4), "image/jpeg");
      return { layout: "cube", prefix: ctx.outputPrefix, ext: "jpg", tileSize: 512, faceSize: 512, levels: [{ size: 512 }], preview: `${ctx.outputPrefix}/preview.jpg` };
    },
    async optimizeModel(ctx) {
      calls.push(`model:${ctx.asset.id}`);
      const src = await ctx.read(ctx.asset.sourceKey);
      await ctx.write(`${ctx.outputPrefix}/model.glb`, src, "model/gltf-binary");
      return { layout: "glb", key: `${ctx.outputPrefix}/model.glb`, bytes: src.byteLength, originalBytes: src.byteLength };
    },
  };
}

export interface Setup {
  app: ReturnType<typeof miu>;
  store: FileStore;
  q: MemoryQueue;
  clock: ManualClock;
  plugin: ReturnType<typeof tour>;
}

export function setup(opts: Partial<TourOptions> & { plugins?: Plugin[]; withQueue?: boolean; withFiles?: boolean; filesPublicUrl?: string; trustProxy?: { header: string } } = {}): Setup {
  const store = opts.store ?? memoryStore();
  const clock = manualClock(Date.UTC(2026, 9, 14, 12));
  const q = memoryQueue({ clock });
  const { plugins = [], withQueue = true, withFiles = true, filesPublicUrl, trustProxy, ...rest } = opts;
  const plugin = tour({ database: sqlite(":memory:"), store, secret: SECRET, processors: [fakeProcessor()], ...rest });
  const list: Plugin[] = [fakeAccess()];
  if (withFiles) list.push(files({ store, secret: SECRET, publicUrl: filesPublicUrl }));
  if (withQueue) list.push(queue({ adapter: q, jobs: plugin.jobs.all }));
  list.push(plugin, ...plugins);
  const app = miu({ name: "tour-test", plugins: list, logLevel: "silent", mcp: true, trustProxy });
  return { app, store, q, clock, plugin };
}

export function json(method: string, body: unknown, headers: Record<string, string> = {}): RequestInit {
  return { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) };
}

export async function call(app: Setup["app"], path: string, init: RequestInit = {}): Promise<{ status: number; body: any; headers: Headers; text: string }> {
  const res = await app.request(path, init);
  const text = await res.text();
  let body: any = text;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {}
  return { status: res.status, body, headers: res.headers, text };
}

/** A published public tour with two panorama scenes linked both ways. */
export async function seedTour(app: Setup["app"], over: Record<string, unknown> = {}) {
  const t = await call(app, "/tours", json("POST", { title: "12 Elm St", slug: "12-elm-st", ...over }, editor));
  if (t.status !== 201) throw new Error(`seed failed: ${t.text}`);
  const s1 = (await call(app, `/tours/${t.body.id}/scenes`, json("POST", { title: "Hall", type: "pano360" }, editor))).body;
  const s2 = (await call(app, `/tours/${t.body.id}/scenes`, json("POST", { title: "Kitchen", type: "pano360", initialView: { yaw: 90, pitch: 0, fov: 70 } }, editor))).body;
  return { tour: t.body, s1, s2 };
}

/** JPEG magic bytes plus padding. */
export function jpegBytes(size = 64): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(size);
  b.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
  return b;
}

/** Minimal GLB header ("glTF", version 2, length). */
export function glbBytes(size = 64): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(size);
  b.set([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0]);
  new DataView(b.buffer).setUint32(8, size, true);
  return b;
}

export interface FakeSocket extends MiuSocket {
  frames: any[];
  closed: { code?: number; reason?: string } | null;
  take(): any[];
  last(t?: string, event?: string): any;
}

let sockets = 0;
export function fakeSocket(): FakeSocket {
  let cursor = 0;
  const s: FakeSocket = {
    id: `sock_${++sockets}`,
    data: undefined,
    frames: [],
    closed: null,
    send(m) {
      s.frames.push(JSON.parse(String(m)));
    },
    close(code, reason) {
      s.closed = { code, reason };
    },
    take() {
      const out = s.frames.slice(cursor);
      cursor = s.frames.length;
      return out;
    },
    last(t, event) {
      for (let i = s.frames.length - 1; i >= 0; i--) {
        const f = s.frames[i];
        if ((!t || f.t === t) && (!event || f.event === event)) return f;
      }
      return undefined;
    },
  };
  return s;
}
