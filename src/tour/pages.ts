import type { Context } from "../core/context.ts";
import { assetUrl } from "./assets.ts";

/**
 * Server-rendered shells for the viewer and editor: one HTML response, no build, no CDN. A fresh nonce per
 * response is the only way a script or style may run (strict CSP; no inline handlers anywhere). Page data
 * travels as inert JSON in <script type="application/json"> with `<` escaped.
 */

function nonce(): string {
  const b = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...b)).replace(/[+/=]/g, (ch) => (ch === "+" ? "-" : ch === "/" ? "_" : ""));
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/** JSON safe to embed in a <script type="application/json"> element. */
export function jsonForHtml(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function csp(n: string, frameAncestors: string): string {
  return [
    "default-src 'none'",
    // 'self' covers the module's own imports (math.js) in browsers that do not propagate the nonce to them.
    `script-src 'nonce-${n}' 'self'`,
    `style-src 'nonce-${n}'`,
    "img-src 'self' blob: data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
    `frame-ancestors ${frameAncestors}`,
  ].join("; ");
}

function render(c: Context<any, any>, o: { title: string; css: string; body: string; data: unknown; script: string; frameAncestors?: string }): Response {
  const n = nonce();
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>${escapeHtml(o.title)}</title>
<style nonce="${n}">${BASE_CSS}${o.css}</style>
</head>
<body>
${o.body}
<script type="application/json" id="miu-tour-data">${jsonForHtml(o.data)}</script>
<script type="module" nonce="${n}" src="${escapeHtml(o.script)}"></script>
</body>
</html>`;
  return c.html(html, 200, {
    "content-security-policy": csp(n, o.frameAncestors ?? "'self'"),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
  });
}

export function viewerPage(c: Context<any, any>, o: { base: string; bundle: { tour: { title: string; description?: string } }; preview: boolean; frameAncestors: string }): Response {
  const t = o.bundle.tour;
  return render(c, {
    title: t.title,
    css: VIEWER_CSS,
    frameAncestors: o.frameAncestors,
    script: assetUrl(o.base, "viewer.js"),
    data: { mode: "viewer", base: o.base, bundle: o.bundle },
    body: `<main id="miu-tour" class="miu-page-viewer" aria-label="360° tour: drag, arrow keys or pinch to look around"></main>
<header class="miu-title"><h1>${escapeHtml(t.title)}</h1>${o.preview ? `<p class="miu-preview">Draft preview — only you can see this page.</p>` : ""}</header>
<nav id="miu-scenes" class="miu-scenes" aria-label="Scenes" hidden></nav>
<noscript><p class="miu-message">This 360° tour needs JavaScript.</p></noscript>`,
  });
}

export function editorPage(c: Context<any, any>, o: { base: string; tourId: string | null; title?: string }): Response {
  return render(c, {
    title: o.title ? `${o.title} · Tour editor` : "Your tours",
    css: EDITOR_CSS,
    script: assetUrl(o.base, "editor.js"),
    data: o.tourId ? { mode: "editor", base: o.base, tourId: o.tourId } : { mode: "tours", base: o.base },
    body: `<div id="miu-editor-app"><p class="miu-status">Loading…</p></div>`,
  });
}

const BASE_CSS = `
:root{color-scheme:light dark;--bg:#0f1115;--fg:#f2f2f2;--muted:#a3a8b3;--accent:#3d8bfd;--panel:#1a1d24;--line:#2c313c;--danger:#e5484d;--ok:#30a46c}
[hidden]{display:none!important}*{box-sizing:border-box}html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:15px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
button,input,select,textarea{font:inherit}
.miu-viewer{position:relative;overflow:hidden;touch-action:none;user-select:none;-webkit-user-select:none;background:#000;cursor:grab;outline:none}
.miu-viewer:active{cursor:grabbing}
.miu-viewer:focus-visible{box-shadow:inset 0 0 0 3px var(--accent)}
.miu-canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
.miu-hotspots{position:absolute;inset:0;pointer-events:none}
.miu-hotspot{position:absolute;left:0;top:0;pointer-events:auto;display:flex;align-items:center;gap:6px;border:0;padding:0;background:none;color:#fff;cursor:pointer}
.miu-hotspot-icon{width:34px;height:34px;border-radius:50%;border:3px solid #fff;background:rgba(61,139,253,.85);box-shadow:0 2px 8px rgba(0,0,0,.5);transition:transform .15s}
.miu-hotspot--info .miu-hotspot-icon{background:rgba(255,183,3,.9)}
.miu-hotspot:hover .miu-hotspot-icon,.miu-hotspot:focus-visible .miu-hotspot-icon{transform:scale(1.15)}
.miu-hotspot:focus-visible{outline:3px solid var(--accent);outline-offset:4px;border-radius:20px}
.miu-hotspot-label{position:absolute;left:50%;top:40px;transform:translateX(-50%);white-space:nowrap;background:rgba(0,0,0,.65);padding:2px 8px;border-radius:4px;font-size:13px;opacity:0;transition:opacity .15s;pointer-events:none}
.miu-hotspot:hover .miu-hotspot-label,.miu-hotspot:focus-visible .miu-hotspot-label,.miu-hotspot.is-selected .miu-hotspot-label{opacity:1}
.miu-hotspot.is-selected .miu-hotspot-icon{border-color:#ffd60a;transform:scale(1.2)}
.miu-hotspot.is-dragging{cursor:grabbing;opacity:.8}
.miu-fade{position:absolute;inset:0;background:#000;opacity:0;pointer-events:none;transition:opacity .18s}
.miu-fade.is-on{opacity:1}
.miu-message{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);max-width:min(90%,32rem);background:rgba(0,0,0,.7);padding:12px 16px;border-radius:8px;text-align:center}
.miu-message[hidden]{display:none}
.miu-popover{position:absolute;left:50%;bottom:24px;transform:translateX(-50%);width:min(92%,26rem);background:var(--panel);color:var(--fg);border:1px solid var(--line);border-radius:10px;padding:14px 40px 14px 16px;box-shadow:0 8px 30px rgba(0,0,0,.5);cursor:auto;user-select:text}
.miu-popover-title{margin:0 0 6px;font-size:17px}.miu-popover-text{margin:0 0 8px;white-space:pre-wrap}
.miu-popover-link{color:var(--accent)}
.miu-popover-close{position:absolute;right:8px;top:6px;border:0;background:none;color:var(--fg);font-size:22px;cursor:pointer}
.miu-flat{position:absolute;inset:0;overflow:auto}.miu-flat img{height:100%;width:auto}
.miu-no-webgl .miu-canvas{display:none}
`;

const VIEWER_CSS = `
.miu-page-viewer{position:fixed;inset:0}
.miu-title{position:fixed;left:12px;top:12px;pointer-events:none;text-shadow:0 1px 4px #000}
.miu-title h1{margin:0;font-size:18px}.miu-preview{margin:4px 0 0;background:#ffd60a;color:#000;padding:2px 8px;border-radius:4px;text-shadow:none;font-size:13px}
.miu-scenes{position:fixed;left:50%;bottom:12px;transform:translateX(-50%);display:flex;gap:6px;max-width:calc(100% - 24px);overflow-x:auto;padding:6px;background:rgba(0,0,0,.55);border-radius:10px}
.miu-scenes[hidden]{display:none}
.miu-scene-button{border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.08);color:#fff;border-radius:6px;padding:6px 10px;cursor:pointer;white-space:nowrap}
.miu-scene-button[aria-current=true]{background:var(--accent);border-color:var(--accent)}
`;

const EDITOR_CSS = `
a{color:var(--accent)}
.miu-editor{display:grid;grid-template-columns:280px 1fr 300px;height:100vh}
.miu-side{overflow:auto;padding:12px;border-right:1px solid var(--line);background:var(--panel)}
.miu-inspector{border-right:0;border-left:1px solid var(--line)}
.miu-main{display:flex;flex-direction:column;min-width:0}
.miu-stage{flex:1;min-height:300px}
.miu-panel{margin:0 0 16px}.miu-panel h2,.miu-upload h2{font-size:14px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:12px 0 8px}
label{display:block;margin:0 0 8px;font-size:13px;color:var(--muted)}
input,select,textarea{display:block;width:100%;margin-top:3px;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
input[type=file]{padding:4px}
button{padding:6px 10px;border:1px solid var(--line);border-radius:6px;background:#252a34;color:var(--fg);cursor:pointer;margin:2px 4px 2px 0}
button:disabled{opacity:.4;cursor:default}button.miu-primary{background:var(--accent);border-color:var(--accent)}button.miu-danger{border-color:var(--danger);color:var(--danger)}
.miu-row{display:flex;gap:6px;align-items:end}.miu-row input{flex:1}
.miu-scene-list{list-style:none;margin:0;padding:0}.miu-scene-list li{display:flex;align-items:center;justify-content:space-between;border-radius:6px;padding:2px 4px}
.miu-scene-list li.is-current{background:rgba(61,139,253,.18)}
.miu-scene-open{flex:1;text-align:left;border:0;background:none;padding:6px 4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.miu-scene-actions button{padding:2px 6px;margin:0 0 0 2px}
.miu-upload input{margin-bottom:6px}.miu-upload progress{width:100%}
.miu-status{margin:6px 12px;min-height:1.4em;color:var(--muted)}.miu-status.is-error{color:var(--danger)}
.miu-hint{color:var(--muted);font-size:13px;margin:6px 12px}
.miu-problems{color:var(--danger);padding-left:18px}
.miu-badge{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px;background:#444}.miu-badge--published{background:var(--ok)}
.miu-tours{max-width:40rem;margin:40px auto;padding:0 16px}.miu-tour-list{padding:0;list-style:none}.miu-tour-list li{padding:8px 0;border-bottom:1px solid var(--line)}
.miu-create{display:flex;gap:8px}.miu-create input{flex:1;margin:0}
.miu-public{margin-left:8px;font-size:13px}
@media (max-width:900px){.miu-editor{grid-template-columns:1fr;height:auto}.miu-stage{height:60vh}.miu-side{border:0}}
`;
