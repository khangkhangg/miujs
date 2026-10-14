import { escapeHtml } from "./shared.ts";

/**
 * Single-file inspector UI: vanilla JS/CSS, no build step, no network beyond its own API, works offline.
 * All data is rendered with `textContent` (never innerHTML); scripts and styles run under a CSP nonce.
 */
export function inspectorPage(p: { base: string; nonce: string }): string {
  const n = escapeHtml(p.nonce);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Miu Inspector</title>
<style nonce="${n}">${CSS}</style>
</head>
<body data-base="${escapeHtml(p.base)}">
<header>
  <strong class="brand">Miu Inspector</strong>
  <span id="live" class="live off" title="Live updates (SSE)">offline</span>
  <nav class="tabs">
    <button data-tab="requests" class="on">Requests <span id="count"></span></button>
    <button data-tab="routes">Routes</button>
  </nav>
  <span id="links" class="links"></span>
  <span class="spacer"></span>
  <button id="pause" title="Pause live updates">Pause</button>
  <button id="clear" title="Clear recorded requests">Clear</button>
  <button id="theme" title="Toggle light/dark">Theme</button>
</header>
<section id="requests" class="view">
  <div class="filters">
    <input id="q" type="search" placeholder="Filter path, route, tool…" autocomplete="off">
    <select id="method"><option value="">All methods</option><option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option><option>OPTIONS</option><option>HEAD</option></select>
    <select id="status"><option value="">All statuses</option><option value="2">2xx</option><option value="3">3xx</option><option value="4">4xx</option><option value="5">5xx</option><option value="err">Errors</option><option value="mcp">MCP calls</option></select>
  </div>
  <div class="split">
    <div class="list"><table><thead><tr><th>Time</th><th>Method</th><th>Path</th><th>Status</th><th class="num">ms</th><th>Route / tool</th></tr></thead><tbody id="rows"></tbody></table>
      <p id="empty" class="muted pad">No requests yet. Make a request to your app and it shows up here.</p></div>
    <aside id="detail" class="detail"><p class="muted pad">Select a request.</p></aside>
  </div>
</section>
<section id="routes" class="view" hidden>
  <div class="pad"><table><thead><tr><th>Method</th><th>Path</th><th>MCP tool</th></tr></thead><tbody id="routeRows"></tbody></table></div>
</section>
<script nonce="${n}">${JS}</script>
</body>
</html>`;
}

const CSS = `
:root{--bg:#fff;--fg:#1c1c21;--muted:#6c6c78;--card:#f4f4f7;--line:#e3e3ea;--sel:#e8efff;--accent:#3d63dd;--ok:#1f8a4c;--warn:#b26b00;--err:#c4302b;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#121215;--fg:#ececf1;--muted:#9a9aa7;--card:#1c1c21;--line:#2b2b33;--sel:#1f2a4a;--accent:#8aa4ff;--ok:#4cc38a;--warn:#f0b04a;--err:#ff6b63;color-scheme:dark}}
:root[data-theme=dark]{--bg:#121215;--fg:#ececf1;--muted:#9a9aa7;--card:#1c1c21;--line:#2b2b33;--sel:#1f2a4a;--accent:#8aa4ff;--ok:#4cc38a;--warn:#f0b04a;--err:#ff6b63;color-scheme:dark}
*{box-sizing:border-box}html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;display:flex;flex-direction:column}
header{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 16px;border-bottom:1px solid var(--line)}
.brand{font-size:14px}.spacer{flex:1}
button,select,input{font:inherit;color:inherit;background:var(--card);border:1px solid var(--line);border-radius:6px;padding:4px 10px}
button{cursor:pointer}button:hover{border-color:var(--accent)}
.tabs button.on{background:var(--accent);border-color:var(--accent);color:#fff}
.live{font-size:11px;padding:2px 8px;border-radius:999px;background:var(--card)}
.live.on{color:var(--ok)}.live.off{color:var(--muted)}
.links a{color:var(--accent);margin-right:8px}
.view{flex:1;min-height:0;display:flex;flex-direction:column}
.filters{display:flex;flex-wrap:wrap;gap:8px;padding:8px 16px;border-bottom:1px solid var(--line)}
.filters input{flex:1;min-width:160px}
.split{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr)}
@media (max-width:800px){.split{grid-template-columns:1fr;grid-template-rows:1fr 1fr}}
.list,.detail{overflow:auto;min-height:0}.detail{border-left:1px solid var(--line)}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:5px 10px;border-bottom:1px solid var(--line);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:340px}
th{position:sticky;top:0;background:var(--bg);color:var(--muted);font-weight:500;font-size:12px}
tbody tr{cursor:pointer}tbody tr:hover{background:var(--card)}tbody tr.sel{background:var(--sel)}
.num{text-align:right;font-variant-numeric:tabular-nums}
.s2{color:var(--ok)}.s3{color:var(--accent)}.s4{color:var(--warn)}.s5{color:var(--err);font-weight:600}
.m{font-weight:600;font-size:11px}
.muted{color:var(--muted)}.pad{padding:12px 16px}
code,pre,.mono{font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
.detail h2{font-size:13px;margin:0;padding:12px 16px 4px;word-break:break-all}
.detail h3{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:14px 16px 6px}
.kv{display:grid;grid-template-columns:max-content 1fr;gap:2px 12px;padding:0 16px}
.kv dt{color:var(--muted)}.kv dd{margin:0;word-break:break-all}
pre{margin:0 16px;background:var(--card);padding:10px;border-radius:6px;white-space:pre-wrap;word-break:break-word;max-height:360px;overflow:auto}
.err{color:var(--err)}
.bars{padding:0 16px}.bar{display:grid;grid-template-columns:120px 1fr 64px;gap:8px;align-items:center;margin:3px 0}
.track{background:var(--card);height:10px;border-radius:3px;position:relative}.fill{background:var(--accent);height:10px;border-radius:3px;min-width:2px}
.toolbar{padding:8px 16px;display:flex;gap:8px}
`;

const JS = `
"use strict";
(() => {
const BASE = document.body.dataset.base;
const $ = (id) => document.getElementById(id);
const h = (tag, props, ...kids) => {
  const el = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === "class") el.className = v; else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) el.append(kid instanceof Node ? kid : String(kid));
  return el;
};
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };

let requests = [], selected = null, paused = false, routes = [];

// theme
const applyTheme = (t) => { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; };
applyTheme(store.get("miu.theme"));
$("theme").onclick = () => {
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  const next = dark ? "light" : "dark"; applyTheme(next); store.set("miu.theme", next);
};

// tabs
for (const b of document.querySelectorAll(".tabs button")) b.onclick = () => {
  for (const x of document.querySelectorAll(".tabs button")) x.classList.toggle("on", x === b);
  for (const v of document.querySelectorAll(".view")) v.hidden = v.id !== b.dataset.tab;
  if (b.dataset.tab === "routes") loadRoutes();
};

const statusClass = (s) => "s" + String(s)[0];
const fmtTime = (iso) => { const d = new Date(iso); return d.toLocaleTimeString([], { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0"); };
const label = (r) => r.mcp ? (r.mcp.tool ? "tool: " + r.mcp.tool : "mcp: " + r.mcp.method) : (r.route || "");

function matches(r) {
  const q = $("q").value.trim().toLowerCase(), m = $("method").value, s = $("status").value;
  if (m && r.method !== m) return false;
  if (s === "err" && !(r.error || r.status >= 500)) return false;
  if (s === "mcp" && !r.mcp) return false;
  if (/^[2-5]$/.test(s) && String(r.status)[0] !== s) return false;
  if (q && !(r.path + "?" + r.query + " " + label(r)).toLowerCase().includes(q)) return false;
  return true;
}

function row(r) {
  return h("tr", { class: selected === r.id ? "sel" : null, "data-id": r.id, onclick: () => select(r.id) },
    h("td", { class: "mono muted", text: fmtTime(r.time) }),
    h("td", { class: "m", text: r.method }),
    h("td", { class: "mono", title: r.path + (r.query ? "?" + r.query : ""), text: r.path + (r.query ? "?" + r.query : "") }),
    h("td", { class: statusClass(r.status), text: r.error ? r.status + " !" : r.status }),
    h("td", { class: "num", text: r.duration }),
    h("td", { class: "muted", text: label(r) }));
}

function render() {
  const list = requests.filter(matches);
  $("rows").replaceChildren(...list.map(row));
  $("empty").hidden = list.length > 0;
  $("count").textContent = requests.length ? "(" + requests.length + ")" : "";
}

const kv = (pairs) => h("dl", { class: "kv" }, pairs.filter((p) => p[1] != null && p[1] !== "").flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { class: "mono", text: String(v) })]));
const pre = (v) => h("pre", { text: typeof v === "string" ? v : JSON.stringify(v, null, 2) });
const headersBlock = (title, o) => [h("h3", { text: title }), Object.keys(o || {}).length ? kv(Object.entries(o)) : h("p", { class: "muted pad", text: "none" })];

function select(id) {
  selected = id;
  for (const tr of $("rows").children) tr.classList.toggle("sel", Number(tr.dataset.id) === id);
  const r = requests.find((x) => x.id === id);
  const d = $("detail");
  if (!r) { d.replaceChildren(h("p", { class: "muted pad", text: "This request is no longer in the buffer." })); return; }
  const parts = [h("h2", null, h("span", { class: statusClass(r.status), text: r.status + " " }), r.method + " " + r.path + (r.query ? "?" + r.query : ""))];
  parts.push(kv([["Time", r.time], ["Duration", r.duration + " ms"], ["Route", r.route], ["MCP", r.mcp && (r.mcp.method + (r.mcp.tool ? " → " + r.mcp.tool : ""))], ["Request size", r.requestSize != null ? r.requestSize + " B" : null], ["Response size", r.responseSize != null ? r.responseSize + " B" : null]]));
  if (r.error) {
    parts.push(h("h3", { class: "err", text: "Error" }), h("pre", { class: "err", text: r.error.name + ": " + r.error.message + (r.error.location ? "\\n    → " + r.error.location : "") }));
    if (r.error.stack.length) parts.push(pre(r.error.stack.join("\\n")));
    for (const c of r.error.cause || []) parts.push(h("h3", { text: "Caused by" }), pre(c.name + ": " + c.message + (c.location ? "\\n    → " + c.location : "")));
  }
  if (r.timing && r.timing.length) {
    const max = Math.max(...r.timing.map((t) => t.dur || 0), 0.1);
    parts.push(h("h3", { text: "Server-Timing" }), h("div", { class: "bars" }, r.timing.map((t) => {
      const fill = h("div", { class: "fill" }); fill.style.width = ((t.dur || 0) / max * 100) + "%";
      return h("div", { class: "bar", title: t.desc || "" }, h("span", { class: "mono", text: t.name }), h("div", { class: "track" }, fill), h("span", { class: "num mono", text: t.dur != null ? t.dur + " ms" : "–" }));
    })));
  }
  parts.push(...headersBlock("Request headers", r.requestHeaders), ...headersBlock("Response headers", r.responseHeaders));
  if (r.requestBody !== undefined) parts.push(h("h3", { text: "Request body" }), pre(r.requestBody));
  if (r.responseBody !== undefined) parts.push(h("h3", { text: "Response body" + (r.truncated ? " (truncated)" : "") }), pre(r.responseBody));
  parts.push(h("div", { class: "toolbar" }, h("button", { text: "Copy as JSON", onclick: () => navigator.clipboard && navigator.clipboard.writeText(JSON.stringify(r, null, 2)) })));
  d.replaceChildren(...parts);
}

for (const id of ["q", "method", "status"]) $(id).addEventListener("input", render);
$("pause").onclick = () => { paused = !paused; $("pause").textContent = paused ? "Resume" : "Pause"; if (!paused) load(); };
$("clear").onclick = async () => { await fetch(BASE + "/api/requests", { method: "DELETE", credentials: "same-origin" }); requests = []; selected = null; render(); $("detail").replaceChildren(h("p", { class: "muted pad", text: "Select a request." })); };

async function load() {
  const res = await fetch(BASE + "/api/requests", { credentials: "same-origin" });
  if (res.ok) { requests = (await res.json()).requests; render(); if (selected) select(selected); }
}

async function loadRoutes() {
  const res = await fetch(BASE + "/api/routes", { credentials: "same-origin" });
  if (!res.ok) return;
  const data = await res.json();
  routes = data.routes;
  $("routeRows").replaceChildren(...routes.map((r) => h("tr", null, h("td", { class: "m", text: r.method }), h("td", { class: "mono", text: r.path }), h("td", { class: r.tool ? "mono" : "muted", text: r.tool || "—" }))));
  const names = { openapi: "OpenAPI", llms: "llms.txt", mcp: "MCP" };
  $("links").replaceChildren(...Object.entries(data.links || {}).map(([k, href]) => k === "mcp" ? h("span", { class: "muted mono", title: "MCP endpoint (POST JSON-RPC)", text: "MCP " + href + "  " }) : h("a", { href, target: "_blank", rel: "noopener", text: names[k] || k })));
}

function connect() {
  const es = new EventSource(BASE + "/events");
  es.onopen = () => { $("live").textContent = "live"; $("live").className = "live on"; };
  es.onerror = () => { $("live").textContent = "reconnecting…"; $("live").className = "live off"; };
  es.addEventListener("request", (e) => { if (paused) return; requests.unshift(JSON.parse(e.data)); render(); });
  es.addEventListener("update", (e) => { const u = JSON.parse(e.data); const i = requests.findIndex((r) => r.id === u.id); if (i >= 0) { requests[i] = u; if (selected === u.id) select(u.id); } });
  es.addEventListener("clear", () => { requests = []; render(); });
}

load(); loadRoutes(); connect();
})();
`;
