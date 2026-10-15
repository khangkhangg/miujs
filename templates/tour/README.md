# {{name}}

A virtual-tour site built with [MiuJS](https://github.com/khangkhangg/miujs) on Bun: creators sign up, upload
360° panoramas, link them with hotspots and publish tours that anyone can open in the browser.

```bash
bun install
bun run seed       # optional: a published "Sample house" tour from generated panoramas
bun run dev        # http://localhost:3000
```

| URL | What |
| --- | --- |
| `/` | landing page listing published tours |
| `/signup`, `/login` | creator accounts (email + password, stored hashed in SQLite) |
| `/editor` | your tours; `/editor/<id>` edits one |
| `/t/<slug>` | the public viewer for a published tour |
<!-- {{#admin}} -->
| `/admin` | back-office for tours, scenes and users (users with the `admin` role) |
<!-- {{/admin}} -->
| `/mcp`, `/openapi.json` | every creator action as an MCP tool / OpenAPI operation |

Data lives in `./data` (`DATA_DIR`): `app.sqlite` plus the uploaded panoramas in `uploads/`.
<!-- {{#admin}} -->

On the first run an admin user `admin@example.com` is created and its password printed once
(set `ADMIN_PASSWORD` beforehand to choose it). Admins can also open and edit every tour in `/editor`.
<!-- {{/admin}} -->

## Create a tour

1. **Sign up** at `/signup`, then open **My tours** (`/editor`) and create a tour. Its slug (the public
   name in `/t/<slug>`) is made from the title; change it in the tour settings.
2. **Upload panoramas**: one scene per panorama. They must be **equirectangular, 2:1** (e.g. 4096x2048
   or 8192x4096, at least 1024 px wide), JPEG, PNG or WebP, up to 30 MB. Export them from your 360°
   camera app as "equirectangular" (not a cube map, fisheye or cropped photo). The first scene becomes
   the start scene.
3. **Link scenes with hotspots**: in a scene, click where a door is to place a **link** hotspot and pick
   the scene it opens; **info** hotspots show a title, text and an optional link. Drag to look around,
   scroll to zoom, and set each scene's initial view.
4. **Publish**: the editor checks the tour first (it needs scenes, a start scene, and every link hotspot
   must target another scene of the same tour), then it is public at `/t/<slug>` and on the landing page.
   Unpublish to hide it again; drafts are only visible to you.

Agents can do the same over MCP (`tour_create`, `scene_import` with a base64 panorama, `hotspot_create`,
`tour_publish`, ...); see `/openapi.json`. `bun run seed [email]` shows the whole flow in code:
`src/sample.ts` builds a tour from `src/panorama.ts`, a tiny generator of synthetic 2:1 rooms.

## Scripts

| Script | What it does |
| --- | --- |
| `bun run dev` | `MIU_ENV=development`, restarts on changes, DevTools on (see below) |
| `bun run start` | production mode (requires `SESSION_SECRET`, sets `Secure` cookies) |
| `bun run seed [email]` | sample tour owned by `email` (default `demo@example.com`, created with a printed password) |
| `bun test` | `test/app.test.ts`: sign up, build, link and publish a tour via `app.request()` |
| `bun run typecheck` | `tsc --noEmit` |

## Configuration

| Variable | Default |
| --- | --- |
| `PORT` | `3000` |
| `DATA_DIR` | `data` |
| `SESSION_SECRET` | random per start in development (sign-ins end on restart); **required** in production |
<!-- {{#admin}} -->
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | `admin@example.com` / generated and printed on first run |
<!-- {{/admin}} -->

## Debugging

With `bun run dev` the request inspector link is printed at the first request (`/__miu?token=…`),
responses carry `Server-Timing` (DevTools → Network → Timing), and errors render a readable page.
Run `MIU_ENV=development bun --inspect src/server.ts` to debug the TypeScript in Chrome DevTools.
None of this is enabled in production.

## Deploy

**Bun** (simplest): `bun install --production`, then `SESSION_SECRET=... PORT=8080 bun run start` behind
an HTTPS reverse proxy. Keep `DATA_DIR` on a persistent volume and back up `app.sqlite` and `uploads/`.
This setup is one server: SQLite and the local disk are not shared between instances.

**Node 22**: the app code is Web-standard; `miujs/sqlite` and `miujs/node` (`diskBlobStore`) also run on
Node (SQLite through `node:sqlite`). Replace `app.listen()` in `src/server.ts` with `serve(app, { port })`
from `miujs/node` and start it with `node --experimental-strip-types src/server.ts`.

**Cloudflare Workers** (scale-out): keep `createApp`'s routes and swap the storage in `src/data.ts` for
Cloudflare drivers from `miujs/cloudflare`: `d1Repository` (users, tours, scenes, hotspots on D1),
`r2BlobStore` (panoramas on R2) and `d1Store` or `kvStore` (sessions, rate limits); then export the app
with `toWorker`. `npx miu wrangler --name {{name}} --d1 DB --r2 PANORAMAS` writes a `wrangler.toml`.
The same drivers let several Bun/Node instances share state too.

Built with [MiuJS](https://github.com/khangkhangg/miujs).
