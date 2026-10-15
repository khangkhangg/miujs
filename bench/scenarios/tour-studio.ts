/**
 * Realistic mixed load for apps/tour-studio (run with bench/scenario.ts or bench/app.ts):
 *
 *   35%  public tour bundle            GET /api/public/tours/demo-house
 *   25%  panorama media                GET /media/... — 200 full (10), 304 If-None-Match (10), 206 range (5)
 *   10%  viewer page                   GET /t/demo-house
 *    5%  landing page                  GET /
 *   10%  creator: list my tours        GET /api/tours (session cookie)
 *   10%  creator: write                POST a hotspot, then DELETE it (session cookie, JSON + X-Requested-With)
 *    5%  agent: MCP tools/list         POST /mcp (Bearer API key)
 *
 * setup() signs up a creator, builds them a tour with two scenes and mints an API key — over HTTP only.
 */
import type { Scenario } from "../lib/scenario.ts";

interface Ctx {
  cookie: string;
  key: string;
  sceneId: string;
  targetSceneId: string;
  media: { url: string; etag: string; size: number }[];
}

const SLUG = "demo-house";

async function must(res: Response, what: string): Promise<any> {
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status} ${await res.text()}`);
  return res.status === 204 ? undefined : res.json();
}

/** A real 1024x512 equirectangular PNG for the creator's scenes (imported as base64, like an agent would). */
async function panoramaPng(): Promise<Uint8Array> {
  const { makePanorama } = await import("../../examples/tour/panorama.ts");
  return makePanorama({ label: "Bench", color: [90, 110, 160], width: 1024 });
}

const b64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

const scenario: Scenario = {
  name: "tour-studio mixed load",
  async setup(base): Promise<Ctx> {
    const ip = `172.16.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
    const email = `bench-${Date.now().toString(36)}@example.com`;
    const json = { "content-type": "application/json", accept: "application/json", "x-requested-with": "bench", "x-forwarded-for": ip };
    const signup = await fetch(`${base}/signup`, { method: "POST", headers: json, body: JSON.stringify({ name: "Bench Creator", email, password: "bench-password-1" }) });
    await must(signup.clone(), "signup");
    const cookie = signup.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const auth = { ...json, cookie };

    const tour = await must(await fetch(`${base}/api/tours`, { method: "POST", headers: auth, body: JSON.stringify({ title: "Bench tour" }) }), "create tour");
    const pano = b64(await panoramaPng());
    const scenes = [];
    for (const title of ["Room A", "Room B"]) {
      scenes.push(await must(await fetch(`${base}/api/tours/${tour.id}/scenes/import`, { method: "POST", headers: auth, body: JSON.stringify({ title, panoramaBase64: pano }) }), "import scene"));
    }
    const { key } = await must(await fetch(`${base}/api/keys`, { method: "POST", headers: auth, body: JSON.stringify({ name: "bench" }) }), "api key");

    const bundle = await must(await fetch(`${base}/api/public/tours/${SLUG}`), "bundle");
    const media = [];
    for (const s of bundle.scenes as { panoramaUrl: string }[]) {
      const r = await fetch(base + s.panoramaUrl);
      const size = (await r.arrayBuffer()).byteLength;
      media.push({ url: s.panoramaUrl, etag: r.headers.get("etag")!, size });
    }
    return { cookie, key, sceneId: scenes[0].id, targetSceneId: scenes[1].id, media };
  },
  steps: [
    { name: "public bundle", weight: 35, run: (base) => fetch(`${base}/api/public/tours/${SLUG}`), ok: (r) => r.status === 200 },
    {
      name: "media 200 full",
      weight: 10,
      run: (base, ctx) => {
        const m = pick((ctx as Ctx).media);
        return fetch(base + m.url);
      },
      ok: (r) => r.status === 200,
    },
    {
      name: "media 304 If-None-Match",
      weight: 10,
      run: (base, ctx) => {
        const m = pick((ctx as Ctx).media);
        return fetch(base + m.url, { headers: { "if-none-match": m.etag } });
      },
      ok: (r) => r.status === 304,
    },
    {
      name: "media 206 range",
      weight: 5,
      run: (base, ctx) => {
        const m = pick((ctx as Ctx).media);
        const start = Math.floor(Math.random() * (m.size - 16384));
        return fetch(base + m.url, { headers: { range: `bytes=${start}-${start + 16383}` } });
      },
      ok: (r) => r.status === 206,
    },
    { name: "viewer page", weight: 10, run: (base) => fetch(`${base}/t/${SLUG}`), ok: (r) => r.status === 200 },
    { name: "landing page", weight: 5, run: (base) => fetch(`${base}/`), ok: (r) => r.status === 200 },
    {
      name: "creator GET /api/tours",
      weight: 10,
      run: (base, ctx) => fetch(`${base}/api/tours`, { headers: { cookie: (ctx as Ctx).cookie, accept: "application/json" } }),
      ok: (r) => r.status === 200,
    },
    {
      name: "creator write (hotspot create+delete)",
      weight: 10,
      run: async (base, ctx) => {
        const c = ctx as Ctx;
        const headers = { cookie: c.cookie, "content-type": "application/json", "x-requested-with": "bench" };
        const created = await fetch(`${base}/api/scenes/${c.sceneId}/hotspots`, {
          method: "POST",
          headers,
          body: JSON.stringify({ kind: "link", yaw: Math.round(Math.random() * 360 - 180), pitch: 0, targetSceneId: c.targetSceneId, title: "Bench" }),
        });
        if (created.status !== 201) return created;
        const { id } = (await created.json()) as { id: string };
        return fetch(`${base}/api/hotspots/${id}`, { method: "DELETE", headers });
      },
      ok: (r) => r.status === 204,
    },
    {
      name: "MCP tools/list (bearer)",
      weight: 5,
      run: (base, ctx) =>
        fetch(`${base}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${(ctx as Ctx).key}` },
          body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
        }),
      ok: (r) => r.status === 200,
    },
  ],
};

function pick<T>(xs: T[]): T {
  return xs[Math.floor(Math.random() * xs.length)]!;
}

export default scenario;
