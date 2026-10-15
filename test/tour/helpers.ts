import { Miu } from "../../src/core/app.ts";
import { memoryRepository } from "../../src/batteries/data/index.ts";
import { memoryBlobStore } from "../../src/batteries/files/index.ts";
import { tourKit, type TourKitOptions, type TourUser } from "../../src/tour/index.ts";
import type { Hotspot, Scene, Tour } from "../../src/tour/schema.ts";
import { makePanorama } from "../../examples/tour/panorama.ts";

export const USERS: Record<string, TourUser> = {
  alice: { id: "alice" },
  bob: { id: "bob" },
  root: { id: "root", roles: ["admin"] },
};

let pano: Promise<Uint8Array> | undefined;
/** A real 1024x512 equirectangular PNG (cached). */
export const samplePano = () => (pano ??= makePanorama({ label: "Test", color: [80, 120, 200], width: 1024 }));

/** Only a PNG header: enough for imageInfo() to read the dimensions. */
export function fakePng(width: number, height: number): Uint8Array {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const dv = new DataView(b.buffer);
  dv.setUint32(16, width);
  dv.setUint32(20, height);
  return b;
}

export function setup(opts: Partial<TourKitOptions> = {}) {
  const tours = memoryRepository<Tour>();
  const scenes = memoryRepository<Scene>();
  const hotspots = memoryRepository<Hotspot>();
  const files = memoryBlobStore();
  const kit = tourKit({
    tours, scenes, hotspots, files,
    authorize: (c) => USERS[c.req.headers.get("x-test-user") ?? ""],
    ...opts,
  });
  const app = new Miu({ logger: false }).route("/", kit);

  /** Requests as `user` (or anonymously), with the CSRF header a browser client sends. */
  const as = (user?: string) => {
    const call = (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      if (user) headers.set("x-test-user", user);
      if (!headers.has("x-requested-with")) headers.set("x-requested-with", "fetch");
      return app.request(path, { ...init, headers });
    };
    const json = (method: string, path: string, body?: unknown) =>
      call(path, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    return {
      call,
      get: (p: string) => call(p),
      post: (p: string, b?: unknown) => json("POST", p, b),
      patch: (p: string, b?: unknown) => json("PATCH", p, b),
      put: (p: string, b?: unknown) => json("PUT", p, b),
      del: (p: string) => json("DELETE", p),
      upload: async (tourId: string, bytes: Uint8Array, title = "Room", type = "image/png") => {
        const fd = new FormData();
        fd.set("panorama", new File([bytes as Uint8Array<ArrayBuffer>], "pano.png", { type }));
        return call(`/api/tours/${tourId}/scenes?title=${encodeURIComponent(title)}`, { method: "POST", body: fd });
      },
    };
  };

  /** Create a tour for `user` with `n` uploaded scenes. */
  const seed = async (user = "alice", n = 2, title = "Villa") => {
    const api = as(user);
    const tour = (await (await api.post("/api/tours", { title })).json()) as Tour;
    const sc: Scene[] = [];
    for (let i = 0; i < n; i++) sc.push((await (await api.upload(tour.id, await samplePano(), `Room ${i + 1}`)).json()) as Scene);
    return { tour, scenes: sc };
  };

  return { app, kit, tours, scenes, hotspots, files, as, seed };
}
