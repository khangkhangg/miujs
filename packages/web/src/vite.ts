import { definePlugin, type App, type Context } from "miujs";
import { webErrors } from "./errors.ts";
import { readTextFile } from "./fs.ts";
import { HtmlString, escapeHtml } from "./html.ts";
import { createStaticHandler } from "./static.ts";

/** One chunk of Vite's `.vite/manifest.json`. */
export interface ViteManifestChunk {
  file: string;
  src?: string;
  name?: string;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
  css?: string[];
  assets?: string[];
}
export type ViteManifest = Record<string, ViteManifestChunk>;

export interface ViteOptions {
  /** Vite dev server URL, e.g. `http://localhost:5173`. Used only when the app runs in dev mode. */
  dev?: string;
  /** Build output folder. Default `dist`. */
  dist?: string;
  /** Manifest path inside `dist`, or the manifest object itself (needed on Workers). Default `.vite/manifest.json`. */
  manifest?: string | ViteManifest;
  /** Vite's `base`. Default `/`. */
  base?: string;
  /** SPA fallback file inside `dist` for HTML navigations, e.g. `index.html`. */
  spa?: string;
}

const HOP_BY_HOP = ["host", "connection", "keep-alive", "transfer-encoding", "upgrade", "accept-encoding", "content-length"];

/**
 * Vite integration. In dev it proxies unmatched GETs to the Vite dev server and `assetTags`
 * loads scripts from it (so the HMR WebSocket connects to Vite directly). In production it
 * serves `dist` with `staticFiles` and `assetTags` reads the build manifest.
 *
 * ```ts
 * const assets = vite({ dev: "http://localhost:5173" });
 * miu({ plugins: [assets], routes: [route.get("/", { handler: () => render(html`<head>${assets.assetTags("src/main.ts")}</head>`) })] });
 * ```
 */
export function vite(opts: ViteOptions = {}) {
  const dist = opts.dist ?? "dist";
  const manifestOpt = opts.manifest ?? ".vite/manifest.json";
  const base = opts.base ?? "/";
  let devUrl: string | null = null;
  if (opts.dev !== undefined) {
    if (!/^https?:\/\/[^/]+/.test(opts.dev)) throw webErrors.config(`Invalid Vite dev URL ${JSON.stringify(opts.dev)}`, 'Pass the full URL Vite prints, e.g. vite({ dev: "http://localhost:5173" }).');
    devUrl = opts.dev.replace(/\/+$/, "");
  }
  const serveDist = createStaticHandler({ dir: dist, spa: opts.spa });
  let mode: "dev" | "production" = "production";
  let manifest: ViteManifest | null = typeof manifestOpt === "object" ? manifestOpt : null;
  let manifestError: unknown = null;
  const manifestPath = typeof manifestOpt === "string" ? `${dist}/${manifestOpt}` : "(object)";

  async function proxy(ctx: Context): Promise<Response> {
    const headers = new Headers(ctx.req.headers);
    for (const h of HOP_BY_HOP) headers.delete(h);
    // String concatenation (not new URL(path, base)) so `//host/x` cannot change the target host.
    const target = devUrl + ctx.path + ctx.url.search;
    let res: Response;
    try {
      res = await fetch(target, { method: ctx.method, headers, redirect: "manual" });
    } catch (err) {
      throw webErrors.viteDevUnreachable(devUrl!, err);
    }
    const out = new Headers(res.headers);
    out.delete("content-encoding");
    out.delete("content-length");
    return new Response(ctx.method === "HEAD" ? null : res.body, { status: res.status, headers: out });
  }

  function chunk(entry: string): ViteManifestChunk {
    if (!manifest) throw webErrors.viteManifest(manifestPath, manifestError ?? undefined);
    const c = manifest[entry];
    if (!c) throw webErrors.viteEntry(entry, Object.keys(manifest).filter((k) => manifest![k].isEntry));
    return c;
  }

  return definePlugin({
    name: "vite",
    async setup(app: App) {
      mode = devUrl && app.dev ? "dev" : "production";
      if (mode === "production" && !manifest && app.runtime !== "workerd") {
        try {
          manifest = JSON.parse(await readTextFile(manifestPath)) as ViteManifest;
        } catch (err) {
          // Reported when assetTags() is called, so API-only routes still start.
          manifestError = err;
          app.log.warn(`vite: manifest ${manifestPath} not found; run \`vite build\``);
        }
      }
    },
    onRequest(ctx: Context) {
      if (ctx.route !== null || (ctx.method !== "GET" && ctx.method !== "HEAD")) return;
      return mode === "dev" ? proxy(ctx) : serveDist(ctx);
    },
    /** `<script type="module">`, stylesheet and modulepreload tags for an entry such as `src/main.ts`. */
    assetTags(entry: string, tagOpts: { nonce?: string } = {}): HtmlString {
      const nonceAttr = tagOpts.nonce ? ` nonce="${escapeHtml(tagOpts.nonce)}"` : "";
      const script = (src: string) => `<script type="module" src="${escapeHtml(src)}"${nonceAttr}></script>`;
      if (mode === "dev") {
        return new HtmlString([script(`${devUrl}/@vite/client`), script(`${devUrl}/${entry.replace(/^\/+/, "")}`)].join("\n"));
      }
      const root = chunk(entry);
      const css: string[] = [];
      const preload: string[] = [];
      const seen = new Set<string>([entry]);
      const visit = (c: ViteManifestChunk) => {
        for (const f of c.css ?? []) if (!css.includes(f)) css.push(f);
        for (const key of c.imports ?? []) {
          if (seen.has(key)) continue;
          seen.add(key);
          const dep = manifest![key];
          if (!dep) continue;
          preload.push(dep.file);
          visit(dep);
        }
      };
      visit(root);
      const url = (f: string) => escapeHtml(base + f);
      return new HtmlString(
        [
          ...css.map((f) => `<link rel="stylesheet" href="${url(f)}">`),
          script(base + root.file),
          ...preload.map((f) => `<link rel="modulepreload" href="${url(f)}">`),
        ].join("\n"),
      );
    },
    inspect() {
      if (mode === "dev") return { mode, dev: devUrl, base };
      return {
        mode,
        dist,
        manifest: typeof manifestOpt === "string" ? manifestOpt : "(object)",
        entries: manifest ? Object.keys(manifest).filter((k) => manifest![k].isEntry) : null,
        base,
      };
    },
  });
}
