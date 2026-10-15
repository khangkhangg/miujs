import { MiuError } from "miujs";

/** Every error @miujs/web throws. Codes are stable; messages and fixes may improve. */
export const webErrors = {
  htmlAsync: () =>
    new MiuError({
      code: "MIU_E_WEB_HTML_ASYNC",
      status: 500,
      message: "A Promise was interpolated into an html`` template or JSX",
      fix: "Await the value before rendering: `const user = await getUser(); html`<p>${user.name}</p>``. Templates render synchronously.",
    }),

  htmlFunction: () =>
    new MiuError({
      code: "MIU_E_WEB_HTML_FUNCTION",
      status: 500,
      message: "A function was interpolated into an html`` template or JSX children",
      fix: "Call the component instead of passing it: `${Layout(props)}` (or `<Layout />` in JSX).",
    }),

  htmlRaw: (value: unknown) =>
    new MiuError({
      code: "MIU_E_WEB_HTML_RAW",
      status: 500,
      message: `raw() expects a string, got ${typeof value}`,
      fix: "Pass a string you trust to raw(), e.g. raw(markdownToHtml(src)). Never pass user input.",
    }),

  jsxTag: (tag: string) =>
    new MiuError({
      code: "MIU_E_WEB_JSX_TAG",
      status: 500,
      message: `Invalid JSX element name ${JSON.stringify(tag)}`,
      fix: "Use a lowercase HTML tag (`div`), a custom element with a dash (`model-viewer`), or a component function.",
    }),

  jsxAttr: (name: string) =>
    new MiuError({
      code: "MIU_E_WEB_JSX_ATTR",
      status: 500,
      message: `Invalid attribute name ${JSON.stringify(name)}`,
      fix: "Attribute names may contain letters, digits, `-`, `_`, `.`, `:` and `@` only. Never build attribute names from user input.",
    }),

  jsxEventHandler: (name: string) =>
    new MiuError({
      code: "MIU_E_WEB_JSX_EVENT_HANDLER",
      status: 500,
      message: `Inline event handler attribute "${name}" is not allowed`,
      fix: `Server-rendered JSX cannot attach functions and inline handlers defeat CSP. Add a listener in a script (\`<script nonce={nonce(ctx)}>el.addEventListener("${name.slice(2).toLowerCase()}", …)</script>\`) or use htmx attributes (hx-post, hx-trigger).`,
    }),

  jsxVoidChildren: (tag: string) =>
    new MiuError({
      code: "MIU_E_WEB_JSX_VOID_CHILDREN",
      status: 500,
      message: `<${tag}> is a void element and cannot have children`,
      fix: `Remove the children of <${tag} />.`,
    }),

  jsxInnerHtml: () =>
    new MiuError({
      code: "MIU_E_WEB_JSX_INNER_HTML",
      status: 500,
      message: "dangerouslySetInnerHTML must be { __html: string } and cannot be combined with children",
      fix: "Pass `dangerouslySetInnerHTML={{ __html: trustedString }}` and no children.",
    }),

  badPath: (path: string) =>
    new MiuError({
      code: "MIU_E_WEB_BAD_PATH",
      status: 400,
      message: `Refused to serve ${JSON.stringify(path.slice(0, 200))}: the path is malformed or tries to leave the static directory`,
      fix: "Request files by their plain URL path, e.g. /assets/app.js. `..`, backslashes, `:` and NUL bytes are not allowed.",
    }),

  config: (message: string, fix: string) => new MiuError({ code: "MIU_E_WEB_CONFIG", status: 500, message, fix }),

  noNonce: () =>
    new MiuError({
      code: "MIU_E_WEB_NO_NONCE",
      status: 500,
      message: "No CSP nonce on this request",
      fix: "Enable a Content-Security-Policy with a nonce: `secureHeaders({ csp: true })` (or `csp: { ...directives }`) in `miu({ plugins })`.",
    }),

  hxUrl: (url: string) =>
    new MiuError({
      code: "MIU_E_WEB_HX_URL",
      status: 500,
      message: `Refused to redirect htmx to ${JSON.stringify(url.slice(0, 200))}`,
      fix: "Pass a path (`/dashboard`) or an http(s) URL. Other schemes such as javascript: are rejected.",
    }),

  viteManifest: (path: string, cause?: unknown) =>
    new MiuError({
      code: "MIU_E_WEB_VITE_MANIFEST",
      status: 500,
      message: `Vite manifest ${JSON.stringify(path)} could not be read`,
      fix: "Run `vite build` with `build.manifest: true` in vite.config, or pass the manifest object: `vite({ manifest: manifestJson })` (required on Workers).",
      cause,
    }),

  viteEntry: (entry: string, known: string[]) =>
    new MiuError({
      code: "MIU_E_WEB_VITE_ENTRY",
      status: 500,
      message: `Vite manifest has no entry ${JSON.stringify(entry)}`,
      fix: `Use the entry's source path relative to the Vite root, as in build.rollupOptions.input. Known entries: ${known.slice(0, 10).join(", ") || "(none)"}.`,
    }),

  viteDevUnreachable: (url: string, cause?: unknown) =>
    new MiuError({
      code: "MIU_E_WEB_VITE_DEV_UNREACHABLE",
      status: 502,
      message: `Vite dev server at ${url} did not respond`,
      fix: "Start it with `bunx vite` (or `bun run dev` in the frontend folder), or fix the `dev` URL passed to vite().",
      cause,
    }),
};
