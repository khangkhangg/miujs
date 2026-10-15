# @miujs/web

> Server-rendered web pages for MiuJS: escaped `html` templates and JSX without a build, static files, htmx helpers, Vite assets and security headers.

`@miujs/web` turns a MiuJS app into a website. `html` tagged templates and the JSX runtime render straight to escaped HTML strings (no virtual DOM), `render()` wraps them in a `text/html` Response, and plugins serve static files, Vite builds and baseline security headers. Use it for server-rendered pages, htmx apps, or to serve a single-page app next to your API.

## Install

```bash
bun add @miujs/web miujs
```

Bun runs the TypeScript source; Node and Deno get prebuilt JS with `.d.ts` types (npm packages are not published yet).

## Quick start

<!-- test -->
```ts
import { miu, route, t } from "miujs";
import { html, render, secureHeaders, staticFiles } from "@miujs/web";

const Layout = (title: string, body: unknown) => html`<!doctype html>
<html><head><title>${title}</title><link rel="stylesheet" href="/app.css"></head>
<body>${body}</body></html>`;

export const hello = route.get("/hello/:name", {
  params: t.object({ name: t.string() }),
  handler: ({ params }) => render(Layout("Hello", html`<h1>Hello ${params.name}</h1>`)),
});

const app = miu({
  routes: [hello],
  plugins: [staticFiles({ dir: "public" }), secureHeaders()],
});
export default app;

const res = await app.request("/hello/%3Cb%3E");
console.log(await res.text()); // <h1>Hello &lt;b&gt;</h1>, inside the layout
```

Interpolated strings are escaped. Nested `html` results, JSX and `raw(trusted)` are inserted as-is. Arrays are flattened; `null`, `undefined` and booleans render nothing. A Promise or a function in a template throws (`MIU_E_WEB_HTML_ASYNC`, `MIU_E_WEB_HTML_FUNCTION`): await data first, call components.

## JSX

Set `"jsx": "react-jsx", "jsxImportSource": "@miujs/web"` in tsconfig.json, or put `/** @jsxImportSource @miujs/web */` at the top of a `.tsx` file. Elements are `HtmlString`s, so they mix freely with `html` and `render()`.

<!-- test -->
```tsx
/** @jsxImportSource @miujs/web */
import { route } from "miujs";
import { render } from "@miujs/web";

const Item = (props: { name: string }) => <li class="item">{props.name}</li>;

export const list = route.get("/list", {
  handler: () => render(<ul>{["a", "<b>"].map((name) => <Item name={name} />)}</ul>),
});
```

`className` becomes `class`, `htmlFor` becomes `for`, `style` accepts an object. Inline event handlers (`onClick`) are rejected (`MIU_E_WEB_JSX_EVENT_HANDLER`); use a nonce'd script or htmx attributes. `dangerouslySetInnerHTML={{ __html }}` is supported for trusted strings.

## htmx

<!-- test -->
```ts
import { route, t } from "miujs";
import { html, hxRedirect, hxTrigger, isHtmx, render, renderPage } from "@miujs/web";

const layout = (body: unknown) => html`<html><body><main>${body}</main></body></html>`;

export const page = route.get("/todos", {
  // htmx requests get the partial; full page loads (and hx-boost) get the layout too.
  handler: (ctx) => renderPage(ctx, html`<ul id="todos"><li>Milk</li></ul>`, layout),
});

export const add = route.post("/todos", {
  body: t.object({ title: t.string({ minLength: 1 }) }),
  handler: ({ body, headers }) => {
    const row = render(html`<li>${body.title}</li>`, { status: 201 });
    return headers.get("hx-request") === "true" ? hxTrigger("todo:added", { title: body.title }, row) : row;
  },
});

export const done = route.post("/done", {
  handler: (ctx) => (isHtmx(ctx) ? hxRedirect("/todos") : new Response(null, { status: 303, headers: { location: "/todos" } })),
});
```

`renderPage` sets `Vary: HX-Request`. `hxRedirect` accepts only paths and http(s) URLs. `hxTrigger(event, detail?, response?)` returns an empty 204 when no response is given.

## Static files

`staticFiles({ dir })` serves a folder for GET/HEAD requests no route matched, with ETag and Last-Modified (304s), single byte ranges, precompressed `.br`/`.gz` siblings, directory `index.html`, and `Cache-Control: immutable` for hashed file names. `..`, backslashes, `:` and NUL bytes are refused with `MIU_E_WEB_BAD_PATH`; dotfiles other than `.well-known` are not served. Use `spa: "index.html"` for client-side routing. `createStaticHandler(opts)` is the same handler for plugins of your own.

## Security headers and CSP nonces

<!-- test -->
```ts
import { miu, route } from "miujs";
import { html, nonce, render, secureHeaders } from "@miujs/web";

export const home = route.get("/", {
  handler: (ctx) => render(html`<script nonce="${nonce(ctx)}">console.log("ok")</script>`),
});

export default miu({
  routes: [home],
  plugins: [secureHeaders({ csp: true, frameAncestors: ["'self'"], hsts: { maxAge: 63072000, preload: true } })],
});
```

Every response gets `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options` plus CSP `frame-ancestors`, `Permissions-Policy`, and HSTS over https. With `csp`, a per-request nonce is added to `script-src` (and to `style-src` unless it allows `'unsafe-inline'`). Headers a handler already set are left alone.

## Vite

<!-- test -->
```ts
import { miu, route } from "miujs";
import { html, render, vite } from "@miujs/web";

const assets = vite({ dev: "http://localhost:5173", spa: "index.html" });

export const index = route.get("/", {
  handler: () => render(html`<!doctype html><head>${assets.assetTags("src/main.ts")}</head><body><div id="app"></div></body>`),
});

export default miu({ routes: [index], plugins: [assets] });
```

In dev mode (`app.dev` and a `dev` URL) unmatched GETs are proxied to the Vite dev server and `assetTags` points at it. In production `dist` is served with the static handler and `assetTags(entry, { nonce })` emits stylesheet, module script and modulepreload tags from the build manifest.

## Options

`staticFiles(options)` / `createStaticHandler(options)`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `dir` | `string` | required | Folder to serve, relative to the working directory. |
| `prefix` | `string` | `"/"` | URL path the folder is mounted at. |
| `spa` | `string` | none | File served for unknown paths when the request accepts HTML. |
| `index` | `string` | `"index.html"` | File served for directory requests. |
| `immutable` | `RegExp` | `DEFAULT_IMMUTABLE` (`/-[A-Za-z0-9_-]{8,}\./`) | Names that get a one-year immutable `Cache-Control`. |
| `precompressed` | `boolean` | `true` | Serve `.br` / `.gz` siblings when accepted. |
| `source` | `FileSource` | `bunFileSource()` on Bun, `nodeFileSource()` elsewhere | Where files are read from. |

`secureHeaders(options)`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `frameAncestors` | `string[]` | `["'none'"]` | CSP `frame-ancestors`; `'none'` sends `X-Frame-Options: DENY`, `'self'` sends `SAMEORIGIN`. |
| `csp` | `boolean \| CspDirectives` | off | `true` uses `DEFAULT_CSP`; an object lists directives (camelCase or kebab-case). Adds a nonce. |
| `hsts` | `false \| { maxAge?, includeSubDomains?, preload? }` | `{ maxAge: 31536000, includeSubDomains: true }` | Sent only over https (or `x-forwarded-proto: https`). |
| `permissionsPolicy` | `false \| Record<string, string[]>` | `DEFAULT_PERMISSIONS_POLICY` | Merged over the defaults (camera, microphone, geolocation, ... disabled). |
| `referrerPolicy` | `string` | `"strict-origin-when-cross-origin"` | `Referrer-Policy` value. |

`vite(options)`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `dev` | `string` | none | Vite dev server URL; used only when the app is in dev mode. |
| `dist` | `string` | `"dist"` | Build output folder. |
| `manifest` | `string \| ViteManifest` | `".vite/manifest.json"` | Manifest path inside `dist`, or the manifest object (required on Workers). |
| `base` | `string` | `"/"` | Vite's `base`. |
| `spa` | `string` | none | SPA fallback file inside `dist`. |

`render(body, { status, headers })` defaults to status 200 and `text/html; charset=utf-8`.

## Errors

- `MIU_E_WEB_HTML_ASYNC`, `MIU_E_WEB_HTML_FUNCTION`: a Promise or function was interpolated ([docs](../../docs/errors.md#miu_e_web_html_async)).
- `MIU_E_WEB_HTML_RAW`: `raw()` got a non-string.
- `MIU_E_WEB_JSX_TAG`, `MIU_E_WEB_JSX_ATTR`, `MIU_E_WEB_JSX_EVENT_HANDLER`, `MIU_E_WEB_JSX_VOID_CHILDREN`, `MIU_E_WEB_JSX_INNER_HTML`: invalid JSX.
- `MIU_E_WEB_BAD_PATH`: a static path tried to leave the folder (400).
- `MIU_E_WEB_NO_NONCE`: `nonce(ctx)` without `secureHeaders({ csp })`.
- `MIU_E_WEB_HX_URL`: `hxRedirect` to a non-http(s) URL.
- `MIU_E_WEB_VITE_MANIFEST`, `MIU_E_WEB_VITE_ENTRY`, `MIU_E_WEB_VITE_DEV_UNREACHABLE`: Vite manifest or dev server problems.
- `MIU_E_WEB_CONFIG`: invalid plugin options.

See [all error codes](../../docs/errors.md).

## Cloudflare Workers

`html`, JSX, `render`, htmx helpers and `secureHeaders` work unchanged. On Workers, `staticFiles()` (and `vite()` in production) does not read the file system: it forwards unmatched GET/HEAD requests to the `ASSETS` binding (Workers Static Assets) and falls through when it returns 404 or is not bound. Configure `[assets]` in `wrangler.toml` yourself; these plugins do not declare it through `cloudflare()`. `vite()` cannot read the manifest file on Workers, so pass the manifest object: `vite({ manifest })`. `bunFileSource()` and `nodeFileSource()` are for Bun, Node and Deno only.

## Links

- [Getting started guide](../../docs/guide.md)
- [Error codes](../../docs/errors.md)
- [AGENTS.md](../../AGENTS.md)
- [Source](./src)
- [Tests](./test)
- [miujs](../miujs/README.md), [@miujs/session](../session/README.md), [@miujs/auth](../auth/README.md), [@miujs/files](../files/README.md)
