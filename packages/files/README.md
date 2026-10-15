# @miujs/files

> File storage for MiuJS: `ctx.files` with memory, local disk, Cloudflare R2 and S3 stores, signed URLs, checked uploads and resumable multipart uploads.

`@miujs/files` adds `ctx.files` to every request: put, get, head, delete and list files by key, sign short-lived download or upload URLs, and accept uploads whose real type is checked from their bytes. The store is swappable: memory in development, a local directory on a server, R2 or any S3-compatible service in production. Use it for avatars, attachments, exports and large assets such as 3D models.

## Install

```bash
bun add @miujs/files miujs
```

Bun runs the TypeScript source; Node and Deno get prebuilt JS with `.d.ts` types (npm packages are not published yet).

## Quick start

<!-- test -->
```ts
import { miu, route, t } from "miujs";
import { files } from "@miujs/files";

export const saveNote = route.put("/notes/:id", {
  params: t.object({ id: t.string() }),
  body: t.object({ text: t.string() }),
  handler: async (ctx) => {
    const stored = await ctx.files.put(`notes/${ctx.params.id}.txt`, ctx.body.text, { contentType: "text/plain" });
    return { key: stored.key, size: stored.size };
  },
});

export const noteLink = route.get("/notes/:id/link", {
  params: t.object({ id: t.string() }),
  handler: async (ctx) => ({ url: await ctx.files.signedUrl(`notes/${ctx.params.id}.txt`, { expiresIn: 300 }) }),
});

// Development: memoryStore() and a random signing secret. Set FILES_SECRET before deploying.
export default miu({ name: "notes", routes: [saveNote, noteLink], plugins: [files()] });
```

`ctx.files` methods:

- `put(key, body, { contentType, metadata })`: store bytes (string, bytes, `Blob` or stream). Returns the stored file info.
- `get(key, { range })`: the file and a stream of its bytes, or `null`.
- `head(key)`, `delete(key)`, `list({ prefix, cursor, limit })`.
- `signedUrl(key, options)`: a URL to the plugin's own route, see below.
- `handleUpload(ctx, options)`: store the files from this request after checking them.

Keys are relative, `/`-separated paths such as `avatars/u1.png`: no leading `/`, no `.` or `..` segments, no backslashes or `:` (max 1024 bytes). `checkKey(key)` validates one.

## Stores

<!-- test -->
```ts
import { files, localStore, memoryStore, r2Store, s3Store } from "@miujs/files";

export const dev = files({ store: memoryStore() });              // default in development
export const disk = files({ store: localStore("./data/files") }); // Bun and Node
export const r2 = files({ store: r2Store("FILES") });            // Cloudflare R2 binding, read per request
export const minio = files({
  store: s3Store({ endpoint: "http://localhost:9000", bucket: "uploads", forcePathStyle: true }),
});
```

- `memoryStore()`: in-process, lost on restart. The plugin refuses to start without a `store` in production (`MIU_E_FILES_STORE_MISSING`).
- `localStore(dir)`: files under `dir`, written to `tmp/` and renamed into place. Bun and Node only.
- `r2Store(binding)`: Cloudflare R2. Pass the binding name (resolved from `ctx.env` per request) or the bucket object. Multipart uploads use R2's native API.
- `s3Store(options)`: AWS S3, R2's S3 API, MinIO, Backblaze B2. Requests are signed with SigV4 over WebCrypto, so it runs everywhere. Each setting is a literal or `{ env: "NAME" }`, and falls back to `S3_*` / `AWS_*` env vars.

## Signed URLs

`signedUrl` returns `{origin}{basePath}/{token}`, an HMAC-signed bearer URL for one method on one key.

<!-- test -->
```ts
import { route } from "miujs";
import "@miujs/files";

export const avatarUpload = route.post("/me/avatar-url", {
  handler: async (ctx) => ({
    // The client PUTs the bytes to this URL with content-type image/png, up to 2 MB.
    put: await ctx.files.signedUrl("avatars/u1.png", { method: "PUT", contentType: "image/png", maxSize: 2 * 1024 * 1024, expiresIn: 600 }),
    // Download as an attachment named avatar.png.
    get: await ctx.files.signedUrl("avatars/u1.png", { download: "avatar.png" }),
  }),
});
```

Downloads support `Range`, `If-None-Match` and `HEAD`. Content types that could run script in the browser are served as attachments with a sandboxing CSP. The secret comes from `files({ secret })`, then `env.FILES_SECRET`, then `env.SESSION_SECRET`; it must be 32+ characters. An array of secrets rotates keys (the first signs, all verify).

## Uploads

`handleUpload` reads `multipart/form-data` or a raw body, detects each file's type from its bytes (`png`, `jpeg`, `webp`, `gif`, `pdf`, `glb`, `mp4`, `zip`), enforces sizes and stores the files. If any file is rejected, none are kept. Use it on routes without a `body` schema.

<!-- test -->
```ts
import { route } from "miujs";
import "@miujs/files";

export const upload = route.post("/photos", {
  handler: async (ctx) => {
    const saved = await ctx.files.handleUpload(ctx, { maxSize: 5 * 1024 * 1024, allowedTypes: ["png", "jpeg", "webp"], maxFiles: 3, prefix: "photos/" });
    return { files: saved.map((f) => ({ key: f.key, type: f.contentType, name: f.filename })) };
  },
});
```

### Resumable multipart uploads

For large files the plugin serves these routes under `{basePath}/uploads` (signed-in users only; turn them off with `multipart: false`):

| Route | Purpose |
| --- | --- |
| `POST /_files/uploads` | Start an upload: body `{ filename?, contentType? }`, returns `{ uploadId, key, expiresAt, maxPartSize, maxSize }`. |
| `PUT /_files/uploads/:id/parts/:n` | Upload part `n` (raw bytes); returns its `etag`. |
| `POST /_files/uploads/:id/complete` | Finish: body `{ parts: [{ partNumber, etag }] }`; returns `{ key, size, etag, contentType }`. |
| `DELETE /_files/uploads/:id` | Abort. |

R2 needs every part except the last to be at least 5 MiB and the same size.

## Options

`files(options)`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `store` | `FileStore` | `memoryStore()` in development; required in production | Where files live. |
| `secret` | `string \| string[]` | `env.FILES_SECRET`, then `env.SESSION_SECRET` | HMAC secret for signed URLs, 32+ characters. |
| `basePath` | `string` | `"/_files"` | Where signed URLs and uploads are served. |
| `publicUrl` | `string` | the request's origin | Origin used in signed URLs. |
| `maxUploadSize` | `number` | `104857600` (100 MiB) | Limit for signed PUT uploads without `maxSize`. |
| `multipart` | `false \| MultipartOptions` | enabled | Resumable upload routes. |
| `onWarning` | `(message) => void` | request logger | Where dev-mode warnings go. |

`multipart` options: `maxSize` (default 5 GiB), `maxPartSize` (default 50 MiB), `allowedTypes`, `expiresIn` (default `86400` s, max 7 days), `key(ctx, file)`.

`signedUrl(key, options)`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `expiresIn` | `number` | `900` | Seconds until the URL stops working (max 7 days). |
| `method` | `"GET" \| "PUT"` | `"GET"` | Download or upload. |
| `contentType` | `string` | none | PUT only: required content type. |
| `maxSize` | `number` | plugin `maxUploadSize` | PUT only: max bytes. |
| `download` | `string` | none | GET only: serve as an attachment with this name. |

`handleUpload(ctx, options)`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `maxSize` | `number` | required | Max bytes per file. |
| `allowedTypes` | `string[]` | required | Accepted types, checked against the bytes. |
| `field` | `string` | `"file"` | Form field holding the file(s). |
| `maxFiles` | `number` | `1` | Most files per request. |
| `prefix` | `string` | `"uploads/"` | Prefix of generated keys. |
| `key` | `(file) => string` | `<prefix><random><ext>` | Choose the key yourself. |
| `metadata` | `Record<string, string>` | none | Extra metadata stored with each file. |

## Errors

- `MIU_E_FILES_KEY_INVALID`: the key is not a safe relative path (400).
- `MIU_E_FILES_NOT_FOUND`: no file under this key (404).
- `MIU_E_FILES_TOO_LARGE`: the file is over `maxSize` (413).
- `MIU_E_FILES_TYPE_NOT_ALLOWED`: the detected type is not in `allowedTypes` (415).
- `MIU_E_FILES_TOKEN_INVALID` / `MIU_E_FILES_TOKEN_EXPIRED`: the signed URL was altered, used with the wrong method, or expired (403).
- `MIU_E_FILES_SECRET_MISSING` / `MIU_E_FILES_SECRET_WEAK`: no signing secret in production, or one shorter than 32 characters.
- `MIU_E_FILES_STORE_MISSING`: no `store` configured in production.
- `MIU_E_FILES_RUNTIME`: `localStore` used outside Bun or Node.
- `MIU_E_FILES_BINDING`: the R2 binding is missing from `env`.
- `MIU_E_FILES_UPLOAD_NOT_FOUND` / `MIU_E_FILES_PART_INVALID`: unknown multipart upload, or a bad part.
- `MIU_E_FILES_CONFIG`: invalid options (bad range, metadata over 2 KB, wrong `signedUrl` options).

See [all error codes](../../docs/errors.md), e.g. [`MIU_E_FILES_NOT_FOUND`](../../docs/errors.md#miu_e_files_not_found).

## Cloudflare Workers

Use `r2Store("FILES")` with an R2 bucket binding, or `s3Store()` with credentials in `wrangler secret`. Set `FILES_SECRET` with `wrangler secret put FILES_SECRET`. With `r2Store("<name>")`, `miu deploy cloudflare` declares the bucket:

```toml
[[r2_buckets]]
binding = "FILES"
bucket_name = "files"
```

`localStore` is Bun/Node only. `memoryStore` works on Workers but is per isolate, so use it only in development.

## Links

- [Getting started guide](../../docs/guide.md)
- [Error codes](../../docs/errors.md)
- [AGENTS.md](../../AGENTS.md)
- [Source](./src)
- [Tests](./test)
- Related: [@miujs/mail](../mail/README.md), [@miujs/workflows](../workflows/README.md), [@miujs/realtime](../realtime/README.md)
