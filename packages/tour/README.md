# @miujs/tour

3D and 360° virtual tours for MiuJS: real-estate listings, clinics and hospitals, showrooms.

The 3D/360° rendering comes from existing browser libraries: [Photo Sphere Viewer](https://photo-sphere-viewer.js.org/)
(with its virtual-tour, markers and tiles plugins) for panoramas, and Google's
[`<model-viewer>`](https://modelviewer.dev/) (three.js) for glTF models. This package supplies
everything around the viewer:

- **Data model and editor API**: tours, scenes (`pano360`, `model3d`, `image`), hotspots
  (`link`, `info`, `media`, `url`), floor plans with per-scene markers. Permissions
  `tours:read` / `tours:write`; read routes are MCP tools.
- **Viewer manifest**: `GET /tours/:tour/manifest.json`, everything a viewer needs, with signed
  asset URLs.
- **Asset pipeline** on `@miujs/queue` jobs with swappable processors.
- **Viewer page**: `GET /tours/:tour/view`, embeddable, CSP with nonce, pinned CDN libraries with SRI.
- **Live guided tours** on `@miujs/realtime`.
- **Analytics** without personal data.
- **Healthcare / real-estate options**: strict privacy, passwords, share links, watermarks.

```ts
import { miu } from "miujs";
import { db, sqlite } from "@miujs/db";
import { files, localStore } from "@miujs/files";
import { queue, schedule } from "@miujs/queue";
import { rooms } from "@miujs/realtime";
import { secureHeaders } from "@miujs/web";
import { tour, guidedTour, vipsProcessor, gltfTransformProcessor } from "@miujs/tour";

const database = sqlite("app.db");
const store = localStore("./data/files");
const live = rooms({ rooms: [guidedTour] });
const tours = tour({ database, store, live, processors: [vipsProcessor(), gltfTransformProcessor()] });

export default miu({
  plugins: [
    db({ database }),
    auth(), access({ roles }),              // provides ctx.authorize for tours:read / tours:write
    files({ store }),                      // the SAME store as tour({ store })
    queue({ jobs: tours.jobs.all, schedules: [schedule("15 0 * * *", tours.jobs.aggregateStats)] }),
    live,
    secureHeaders({ csp: true }),          // optional; the viewer page sets its own CSP
    tours,
  ],
});
```

## Routes

All `:tour` parameters accept the tour id (`tour_…`) or its slug.

| Route | Permission | MCP | What |
|---|---|---|---|
| `GET /tours` | `tours:read` | yes | List tours (scoped to the active org) |
| `POST /tours` | `tours:write` | | Create (starts as a private draft) |
| `GET /tours/:tour` | `tours:read` | yes | Tour with scenes, hotspots, floor plans, asset states |
| `PATCH /tours/:tour` | `tours:write` | | Title, slug, status, visibility, privacy, watermark, `allowedEmbedOrigins`, start scene, password |
| `DELETE /tours/:tour` | `tours:write` | | |
| `POST /tours/:tour/scenes`, `PATCH`/`DELETE /tours/:tour/scenes/:scene` | `tours:write` | | Scenes (initial view yaw/pitch/fov in degrees, floor, order) |
| `POST /tours/:tour/scenes/:scene/hotspots`, `PATCH`/`DELETE /tours/:tour/hotspots/:hotspot` | `tours:write` | | Hotspots: `{yaw, pitch}` on panoramas, `{x, y, z}` on models, `{x, y}` (0..1) on images |
| `PUT`/`DELETE /tours/:tour/floorplans/:floor` | `tours:write` | | Plan image key + markers `{sceneId, x, y}` (0..1) |
| `POST /tours/:tour/scenes/:scene/upload` | `tours:write` | | Upload the source (raw body or multipart `file`); type checked from magic bytes; queues processing |
| `PUT /tours/:tour/scenes/:scene/asset` | `tours:write` | | Attach a file uploaded with `@miujs/files` resumable multipart uploads (`{key}`) |
| `GET /tours/:tour/assets` | `tours:read` | yes | Processing state per asset: `queued` / `processing` / `ready` / `failed`, progress, error |
| `POST /tours/:tour/assets/:asset/retry` | `tours:write` | | Queue again |
| `GET /tours/:tour/manifest.json` | viewer | yes | The viewer manifest |
| `GET /tours/:tour/view` | viewer | | The viewer page (`?live=<code>`, `?share=<token>`) |
| `POST /tours/:tour/unlock` | viewer | | Password → HttpOnly cookie (rate limited) |
| `POST /tours/:tour/share`, `POST /tours/:tour/share/revoke` | `tours:write` | | Signed share links with expiry; revoke all |
| `POST /tours/:tour/live` | `tours:write` | | Start a live guided tour: join code, follow link, guide link |
| `POST /tours/:tour/events` | viewer | | Analytics beacon (rate limited) |
| `GET /tours/:tour/stats` | `tours:read` | yes | Daily views, sessions, dwell per scene, top hotspots |
| `GET /tours/_tiles/:token/*path` | token | | Tiles (prefix-scoped signed token) |
| `POST /tours/_processor/callback` | HMAC | | Results from `externalProcessor()` |

Who may open a tour as a viewer: **published** + `public` or `unlisted` → everyone; `private` or
password-protected → a share link (`?share=`) or the unlock cookie; drafts → only users who
pass `ctx.can("tours:read")` (preview). Unlisted, private and shared pages are `noindex`.

## Signed URLs and caching

- Single files (models, previews, plan images, media) use `ctx.files.signedUrl()`.
- Tile pyramids use one prefix-scoped tour token (`/tours/_tiles/<token>/{level}/{face}/{row}_{col}.jpg`),
  because signing every tile would not scale.
- **Public** tours sign with an expiry aligned to the UTC day (valid 6-7 days): every visitor gets
  identical URLs for a day, so browsers and CDNs can cache them (`manifest.json`: `public, max-age=60`;
  tiles: `public, immutable`). Output prefixes are unique per processing run, so a cached tile never goes stale.
- **Private / unlisted / shared / preview** access gets 10-minute URLs (`urls.privateTtl`) and
  `private, no-store`. The viewer refreshes the manifest before `expiresAt`.

## Asset processing

Assets go through queue jobs (`tours.jobs.tilePanorama`, `tours.jobs.optimizeModel`); register
them with `queue({ jobs: tours.jobs.all })`. Startup fails with `MIU_E_TOUR_JOBS_NOT_REGISTERED`
if the queue does not run them. Each run picks the first processor that implements the step,
writes under a unique `outputPrefix`, and the result is validated before it is served.

| Processor | Where it runs | Output |
|---|---|---|
| `vipsProcessor()` | Bun/Node host with libvips (`vips`, `vipsheader`) | Equirectangular tile pyramid (`vips dzsave --layout google`), widths `tileSize·2ⁿ`, plus a preview. Shown with PSV's EquirectangularTilesAdapter. |
| `gltfTransformProcessor()` | Bun/Node host with npx (+ `toktx` for KTX2) | `npx --yes @gltf-transform/cli@4.5.0 optimize` with Draco (default) or meshopt, KTX2 (default) or WebP textures |
| `cloudflareImagesProcessor({ accountId, token })` | anywhere (one `fetch`) | Panorama uploaded to Cloudflare Images, served at several widths through flexible variants (enable them; mind Cloudflare's upload size/megapixel limits) |
| `externalProcessor({ url, secret })` | your container / server | Anything: POSTs a signed job, results arrive at `POST /tours/_processor/callback` |

The manifest also understands the **cube** layout (`{level}/{face}/{row}_{col}`, faces `f b l r u d`,
PSV CubemapTilesAdapter / Marzipano naming) for processors that produce cube faces, e.g. a
container running krpano or the Marzipano tool behind `externalProcessor()`.

> **Cloudflare Workers cannot process assets.** A Worker has tight CPU-time and memory limits
> (128 MB) and cannot spawn programs: tiling a 100-megapixel panorama or compressing a model does
> not fit. On Workers, use `externalProcessor()` (a Cloudflare Container, Fly machine, VPS…) or
> `cloudflareImagesProcessor()`. `vipsProcessor()` / `gltfTransformProcessor()` are refused at
> startup when building for Workers (`MIU_E_TOUR_PROCESSOR_UNAVAILABLE`).

### External processor protocol

The job is POSTed as JSON with `x-miu-tour-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`:

```json
{ "step": "tilePanorama", "assetId": "ast_…", "run": 1, "tourId": "tour_…", "tourSlug": "elm",
  "sourceKey": "tours/…/src/….jpg", "contentType": "image/jpeg", "size": 123,
  "outputPrefix": "tours/…/out/ast_…/r1", "callbackUrl": "https://app.example.com/tours/_processor/callback" }
```

Answer 2xx, read `sourceKey` from the same bucket, write outputs under `outputPrefix/`, then POST
signed callbacks: `{assetId, run, status: "processing", progress}`, `{assetId, run, status: "ready", result}`
(a `PanoramaResult` or `ModelResult`, see `src/processor.ts`) or `{assetId, run, status: "failed", error}`.
Signatures older than 5 minutes and callbacks for an older run are refused.

## Viewer page and embedding

`tourPage(manifestUrl, { nonce, manifest, assets, live })` renders the page with `@miujs/web`'s
`html` (everything escaped; inline JSON cannot close its `<script>`). Every script carries the
CSP nonce; libraries are pinned (`VIEWER_ASSETS`: Photo Sphere Viewer 5.15.1, three 0.185.1,
`<model-viewer>` 4.3.1) with SRI hashes (import-map `integrity` for modules, `integrity` on
stylesheets and `<model-viewer>`). `tourCsp()` builds the matching policy.

Embedding is per tour: `PATCH /tours/:tour { "allowedEmbedOrigins": ["https://listings.example.com"] }`
becomes `frame-ancestors` on that tour's page (default `'self'`). The page sets its own CSP, which
`secureHeaders()` leaves alone; it reuses `secureHeaders`' nonce when present.

## Live guided tours

`rooms({ rooms: [guidedTour] })` + `tour({ live })`. `POST /tours/:tour/live` returns a 6-digit
code, a follow link (`/view?live=<code>`, with a share token for protected tours) and a guide link
(`…#guide=<token>`; the fragment never reaches servers or logs). Followers join as spectators;
the guide claims the room with the token. Guide-only messages (`camera`, `pointer`, `ack`, `end`)
check the role. Camera updates reach followers at most 10 times a second (the room rate limit plus
coalescing with `room.schedule`); followers detach locally by moving the view and can rejoin.
Followers can raise a hand; the guide sees the queue and answers. Double-click points at a spot.

## Analytics

The viewer sends a random per-tab session id, scene ids with dwell times and hotspot clicks to
`POST /tours/:tour/events` (rate limited per client; on Workers pass `analytics.rateLimitBinding`
for a Cloudflare Rate Limiting binding). Raw events keep a coarse network prefix (IPv4 /24, IPv6
/48) unless the tour uses `privacy: "strict"`, which stores none. `tours.jobs.aggregateStats`
(or `GET /tours/:tour/stats`) rolls them up per day; raw events are pruned after `retentionDays` (30).

## Privacy options: building blocks, not compliance

`privacy: "strict"` (per tour) stores no IP data with analytics and forbids third-party CDNs: the
page refuses to render (`MIU_E_TOUR_STRICT_CDN`) until the viewer is self-hosted. Passwords
(PBKDF2-SHA256), expiring share links, `noindex`, `no-referrer` and watermarks (`watermark` text
overlay) are available for listings and clinical spaces.

**These are building blocks, not compliance.** Nothing here makes an app HIPAA, GDPR or
fair-housing compliant: that depends on your contracts (BAAs/DPAs with your hosting, storage and
CDN providers), your access policies, consent, retention, audit logging and what you photograph.
Do not put identifiable patients or personal information in panoramas.

### Self-hosting the viewer

Download each file in `VIEWER_ASSETS` from its `cdn` URL to `<static dir><basePath>/<path>`, the
two decoder folders in `MODEL_DECODERS`, serve them with `staticFiles()`, and pass
`tour({ viewerAssets: { basePath: "/vendor/tour" } })`:

```ts
// scripts/vendor-tour.ts — run once with Bun, commit public/vendor/tour
import { VIEWER_ASSETS } from "@miujs/tour";
for (const a of Object.values(VIEWER_ASSETS)) {
  const bytes = new Uint8Array(await (await fetch(a.cdn)).arrayBuffer());
  await Bun.write(`public/vendor/tour/${a.path}`, bytes);
}
// Also copy the Draco decoder (draco_decoder.js/.wasm, draco_wasm_wrapper.js) and the Basis
// transcoder (basis_transcoder.js/.wasm) from MODEL_DECODERS into public/vendor/tour/decoders/{draco,basis}/.
```

```ts
miu({ plugins: [staticFiles({ dir: "public" }), tour({ viewerAssets: { basePath: "/vendor/tour" } })] });
```

The SRI hashes still apply to self-hosted files, so a modified copy fails to load.

## Errors

Every error is a `MiuError` with a `MIU_E_TOUR_*` code and a `fix` (see `tourErrors`).
