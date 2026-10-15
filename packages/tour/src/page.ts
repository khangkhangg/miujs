// The embeddable viewer page. Server-rendered with @miujs/web `html` (everything escaped),
// libraries pinned with SRI, every script under the CSP nonce. No build step.
import { html, raw, type HtmlString } from "@miujs/web";
import { LIVE_JS, VIEWER_JS } from "./client.ts";
import type { Manifest } from "./manifest.ts";
import type { ViewerAssetsSelfHosted } from "./runtime.ts";
import { CDN_ORIGINS, IMPORT_MAP_ENTRIES, MODEL_DECODERS, VIEWER_ASSETS, type ViewerAsset } from "./viewer-assets.ts";

for (const [name, code] of [["VIEWER_JS", VIEWER_JS], ["LIVE_JS", LIVE_JS]]) {
  if (/<\/script|<!--/i.test(code)) throw new Error(`${name} must not contain "</script" or "<!--"`);
}

export interface TourPageOptions {
  /** The CSP nonce of this response (from secureHeaders' `nonce(ctx)`, or your own). */
  nonce: string;
  /** Inline the manifest (first paint without a round trip, server-rendered floor plan and scene list). */
  manifest?: Manifest;
  /** Page title. Default: the tour title. */
  title?: string;
  /** "cdn" (default) or self-hosted files (see VIEWER_ASSETS and the README). */
  assets?: "cdn" | ViewerAssetsSelfHosted;
  /** Include the live guided tour client for this join code. */
  live?: { code: string; roomsPath: string } | null;
  /** Add `<meta name="robots" content="noindex">` (unlisted, private, shared). */
  noindex?: boolean;
  lang?: string;
}

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

/** JSON safe inside a <script> element. */
export function scriptJson(value: unknown): HtmlString {
  return raw(JSON.stringify(value).replace(/</g, "\\u003c").split(LS).join("\\u2028").split(PS).join("\\u2029"));
}

function urlOf(a: ViewerAsset, assets: TourPageOptions["assets"]): string {
  return assets && assets !== "cdn" ? `${assets.basePath.replace(/\/+$/, "")}/${a.path}` : a.cdn;
}

function needs(m: Manifest | undefined): { pano: boolean; model: boolean } {
  if (!m) return { pano: true, model: true };
  return { pano: m.scenes.some((s) => s.type === "pano360"), model: m.scenes.some((s) => s.type === "model3d") };
}

const CSS = `
html,body{margin:0;height:100%;background:#111;color:#eee;font:15px/1.4 system-ui,sans-serif}
.miu-tour{position:relative;width:100%;height:100%;overflow:hidden}
.miu-tour-stage,.miu-tour-psv,.miu-tour-model,.miu-tour-image{position:absolute;inset:0;width:100%;height:100%}
.miu-tour-image img{width:100%;height:100%;object-fit:contain}
.miu-tour-status{position:absolute;inset:auto 0 50% 0;text-align:center}
.miu-tour-watermark{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;user-select:none;font-size:clamp(18px,5vw,56px);font-weight:700;color:rgba(255,255,255,.28);text-shadow:0 0 4px rgba(0,0,0,.4);transform:rotate(-20deg);z-index:50}
.miu-tour-floorplan{position:absolute;right:12px;bottom:56px;width:min(32vw,260px);z-index:60;background:rgba(0,0,0,.55);border-radius:8px;padding:6px}
.miu-tour-floorplan figure{position:relative;margin:0}
.miu-tour-floorplan img{display:block;width:100%}
.miu-tour-marker{position:absolute;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;border:2px solid #fff;background:#2a7de1;padding:0;cursor:pointer}
.miu-tour-marker[aria-current]{background:#f5a623}
.miu-tour-index{position:absolute;left:12px;top:12px;z-index:60;background:rgba(0,0,0,.55);border-radius:8px;padding:6px 10px;max-width:min(60vw,320px);max-height:70vh;overflow:auto}
.miu-tour-scenes{list-style:none;margin:0;padding:0}
.miu-tour-scenes button{background:none;border:0;color:inherit;font:inherit;cursor:pointer;padding:2px 0}
.miu-tour-scenes button[aria-current]{font-weight:700}
.miu-tour-info{font-size:13px;opacity:.85;margin:0 0 6px 10px}
.miu-tour-panel{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:70;background:#fff;color:#111;border-radius:10px;padding:16px 20px;max-width:min(90vw,520px);max-height:80vh;overflow:auto}
.miu-tour-panel img,.miu-tour-panel video{max-width:100%}
.miu-tour-close{float:right;border:0;background:none;font-size:22px;cursor:pointer}
.miu-tour-hs{display:block;width:32px;height:32px;border-radius:50%;border:2px solid #fff;background:rgba(42,125,225,.85);cursor:pointer;position:absolute;transform:translate(-50%,-50%)}
.miu-tour-pointer{display:block;width:48px;height:48px;border-radius:50%;border:3px solid #f5a623;animation:miu-pulse 1s ease-out infinite}
@keyframes miu-pulse{from{transform:scale(.6);opacity:1}to{transform:scale(1.4);opacity:0}}
.miu-tour-live{position:absolute;left:50%;bottom:12px;transform:translateX(-50%);z-index:65;background:rgba(0,0,0,.65);border-radius:8px;padding:6px 10px;display:flex;gap:8px;align-items:center}
.miu-tour-live button{font:inherit}
[hidden]{display:none!important}
`;

/** The viewer page for `manifestUrl`. Pass the result to `render()` from @miujs/web. */
export function tourPage(manifestUrl: string, opts: TourPageOptions): HtmlString {
  const { nonce, manifest: m, assets = "cdn" } = opts;
  const need = needs(m);
  const selfHosted = assets !== "cdn";
  const title = opts.title ?? m?.tour.title ?? "Virtual tour";
  const base = selfHosted ? assets.basePath.replace(/\/+$/, "") : "";

  const importMap = { imports: {} as Record<string, string>, integrity: {} as Record<string, string> };
  for (const [spec, k] of Object.entries(IMPORT_MAP_ENTRIES)) importMap.imports[spec] = urlOf(VIEWER_ASSETS[k], assets);
  for (const k of [...new Set([...Object.values(IMPORT_MAP_ENTRIES), "threeCore" as const])]) {
    const a = VIEWER_ASSETS[k];
    if (a.integrity) importMap.integrity[urlOf(a, assets)] = a.integrity;
  }
  const css = [VIEWER_ASSETS.psvCoreCss, VIEWER_ASSETS.psvMarkersCss, VIEWER_ASSETS.psvVirtualTourCss];
  const config = {
    manifestUrl,
    decoders: selfHosted
      ? { draco: `${base}/${MODEL_DECODERS.draco.path}`, ktx2: `${base}/${MODEL_DECODERS.basis.path}`, meshopt: urlOf(VIEWER_ASSETS.meshoptDecoder, assets) }
      : { meshopt: VIEWER_ASSETS.meshoptDecoder.cdn },
  };

  const plans = m?.floorPlans ?? [];
  const sceneTitle = new Map((m?.scenes ?? []).map((s) => [s.id, s.title]));

  return html`<!doctype html>
<html lang="${opts.lang ?? "en"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${opts.noindex ? html`<meta name="robots" content="noindex">` : ""}
${need.pano ? css.map((a) => html`<link rel="stylesheet" href="${urlOf(a, assets)}" integrity="${a.integrity}" crossorigin="anonymous">\n`) : ""}
<style nonce="${nonce}">${raw(CSS)}</style>
${need.pano ? html`<script type="importmap" nonce="${nonce}">${scriptJson(importMap)}</script>` : ""}
${need.model ? html`<script type="module" src="${urlOf(VIEWER_ASSETS.modelViewer, assets)}" integrity="${VIEWER_ASSETS.modelViewer.integrity}" crossorigin="anonymous" nonce="${nonce}"></script>` : ""}
</head>
<body>
<div id="miu-tour" class="miu-tour" data-manifest-url="${manifestUrl}">
<div class="miu-tour-stage" role="application" aria-label="${title}"></div>
<p class="miu-tour-status" role="status">Loading tour...</p>
${m?.tour.watermark ? html`<div class="miu-tour-watermark" aria-hidden="true">${m.tour.watermark}</div>` : ""}
${plans.map(
  (p) => html`<nav class="miu-tour-floorplan" aria-label="Floor plan"><figure><img src="${p.image.url}" alt="${p.title ?? `Floor ${p.floor}`}" loading="lazy">${p.markers.map(
    (mk) => html`<button type="button" class="miu-tour-marker" data-scene="${mk.sceneId}" data-x="${mk.x}" data-y="${mk.y}" aria-label="${sceneTitle.get(mk.sceneId) ?? mk.sceneId}"></button>`,
  )}</figure></nav>`,
)}
${m && m.scenes.length
  ? html`<details class="miu-tour-index"><summary>Scenes</summary><ul class="miu-tour-scenes">${m.scenes.map(
      (s) => html`<li><button type="button" data-scene="${s.id}">${s.title}</button>${s.hotspots
        .filter((h) => h.kind === "info")
        .map((h) => html`<div class="miu-tour-info">${h.title ? html`<strong>${h.title}</strong>` : ""}${raw(h.bodyHtml ?? "")}</div>`)}</li>`,
    )}</ul></details>`
  : ""}
<aside class="miu-tour-panel" role="dialog" aria-modal="false" hidden><button type="button" class="miu-tour-close" aria-label="Close">&times;</button><div class="miu-tour-panel-body"></div></aside>
${opts.live
  ? html`<div class="miu-tour-live" aria-live="polite"><span data-live="status">Connecting to the live tour...</span><button type="button" data-live="detach" hidden>Rejoin guide</button><button type="button" data-live="raise" aria-pressed="false">Raise hand</button><button type="button" data-live="end" hidden>End tour</button><ul data-live="hands" hidden></ul></div>`
  : ""}
</div>
<script type="application/json" id="miu-tour-config" nonce="${nonce}">${scriptJson(config)}</script>
${m ? html`<script type="application/json" id="miu-tour-manifest" nonce="${nonce}">${scriptJson(m)}</script>` : ""}
${opts.live ? html`<script type="application/json" id="miu-tour-live" nonce="${nonce}">${scriptJson({ code: opts.live.code, roomsPath: opts.live.roomsPath })}</script>` : ""}
<script type="module" nonce="${nonce}">${raw(VIEWER_JS)}</script>
${opts.live ? html`<script type="module" nonce="${nonce}">${raw(LIVE_JS)}</script>` : ""}
</body>
</html>
`;
}

export interface TourCspOptions {
  nonce: string;
  assets?: "cdn" | ViewerAssetsSelfHosted;
  /** Who may embed the page (CSP frame-ancestors). Default `'self'`. */
  frameAncestors?: string[];
  /** Origins serving signed asset URLs when they differ from the page (files `publicUrl`, a CDN). */
  assetOrigins?: string[];
}

/** The Content-Security-Policy for the viewer page. */
export function tourCsp(opts: TourCspOptions): string {
  const cdn = opts.assets && opts.assets !== "cdn" ? [] : CDN_ORIGINS;
  const extra = [...new Set(opts.assetOrigins ?? [])];
  const frame = opts.frameAncestors?.length ? opts.frameAncestors : ["'self'"];
  const d: [string, string[]][] = [
    ["default-src", ["'self'"]],
    // 'wasm-unsafe-eval': Draco/KTX2/meshopt decoders are WebAssembly. No 'unsafe-eval'.
    ["script-src", ["'self'", `'nonce-${opts.nonce}'`, "'wasm-unsafe-eval'", ...cdn]],
    // Photo Sphere Viewer and <model-viewer> set inline styles.
    ["style-src", ["'self'", "'unsafe-inline'", ...cdn.slice(0, 1)]],
    ["img-src", ["'self'", "data:", "blob:", ...extra]],
    ["media-src", ["'self'", "blob:", ...extra]],
    ["connect-src", ["'self'", "data:", "blob:", ...extra, ...cdn]],
    ["font-src", ["'self'", "data:"]],
    ["worker-src", ["'self'", "blob:"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'none'"]],
    ["form-action", ["'self'"]],
    ["frame-ancestors", frame],
  ];
  return d.map(([k, v]) => `${k} ${v.join(" ")}`).join("; ");
}
