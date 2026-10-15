/**
 * The admin UI: one HTML page with inline CSS and JS (no build step, no CDN), driven by `api/_meta`.
 * Served with a per-response CSP nonce; the script renders only through DOM APIs and `textContent`
 * (never `innerHTML` with data) and wires events with `addEventListener` (no inline handlers).
 */
export interface PageOptions {
  title: string;
  nonce: string;
  loginUrl?: string;
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ESC[ch]!);
}

export function renderPage({ title, nonce, loginUrl }: PageOptions): string {
  const t = escapeHtml(title);
  const login = loginUrl && loginUrl.startsWith("/") ? escapeHtml(loginUrl) : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="same-origin">
<title>${t}</title>
<link rel="icon" href="data:,">
<style nonce="${nonce}">${CSS}</style>
</head>
<body data-login="${login}">
<a class="skip" href="#main">Skip to content</a>
<header class="top">
  <button id="menu" class="icon-btn" type="button" aria-label="Show navigation" aria-expanded="false" aria-controls="nav">&#9776;</button>
  <span class="brand">${t}</span>
  <span class="spacer"></span>
  <span id="who" class="who"></span>
  <button id="theme" class="icon-btn" type="button" aria-label="Switch to dark theme">&#9680;</button>
</header>
<div class="layout">
  <nav id="nav" aria-label="Resources"><ul id="nav-list"></ul></nav>
  <main id="main" tabindex="-1"><p class="muted">Loading&hellip;</p></main>
</div>
<div id="toast" class="toast" role="status" aria-live="polite"></div>
<dialog id="confirm" aria-labelledby="confirm-title" aria-describedby="confirm-text">
  <form method="dialog">
    <h2 id="confirm-title">Delete record?</h2>
    <p id="confirm-text"></p>
    <div class="actions">
      <button class="btn" value="cancel">Cancel</button>
      <button class="btn danger" value="ok">Delete</button>
    </div>
  </form>
</dialog>
<script nonce="${nonce}">${JS}</script>
</body>
</html>`;
}

const CSS = String.raw`
:root{--bg:#f6f7f9;--panel:#fff;--text:#16181d;--muted:#5b6170;--border:#d9dce3;--accent:#3557d4;--accent-text:#fff;--danger:#c0362c;--danger-text:#fff;--focus:#f5a623;--row:#f0f2f6;--ok:#1d7a46;--shadow:0 1px 2px rgba(0,0,0,.06),0 4px 16px rgba(0,0,0,.06);color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#111317;--panel:#1a1d23;--text:#e8eaef;--muted:#9aa1b1;--border:#2e333d;--accent:#7c96ff;--accent-text:#0b0d12;--danger:#ff6b5e;--danger-text:#0b0d12;--row:#22262e;--ok:#5fd394;--shadow:none;color-scheme:dark}}
:root[data-theme=dark]{--bg:#111317;--panel:#1a1d23;--text:#e8eaef;--muted:#9aa1b1;--border:#2e333d;--accent:#7c96ff;--accent-text:#0b0d12;--danger:#ff6b5e;--danger-text:#0b0d12;--row:#22262e;--ok:#5fd394;--shadow:none;color-scheme:dark}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent)}
:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
.skip{position:absolute;left:-999px;top:0;background:var(--panel);padding:8px 12px;z-index:10}
.skip:focus{left:8px}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.top{display:flex;align-items:center;gap:12px;padding:10px 16px;background:var(--panel);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:5}
.brand{font-weight:650;font-size:1.05rem}
.spacer{flex:1}
.who{color:var(--muted);font-size:.9rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:40vw}
.icon-btn{background:none;border:1px solid var(--border);color:var(--text);border-radius:8px;min-width:36px;min-height:36px;font-size:1.1rem;cursor:pointer}
#menu{display:none}
.layout{display:grid;grid-template-columns:220px minmax(0,1fr);min-height:calc(100vh - 57px)}
nav{border-right:1px solid var(--border);background:var(--panel);padding:12px 8px}
nav ul{list-style:none;margin:0;padding:0}
nav a{display:block;padding:8px 12px;border-radius:8px;text-decoration:none;color:var(--text)}
nav a:hover{background:var(--row)}
nav a[aria-current=page]{background:var(--accent);color:var(--accent-text);font-weight:600}
main{padding:20px 24px;min-width:0}
main:focus{outline:none}
h2{margin:0;font-size:1.35rem}
h2:focus{outline:none}
.toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.muted{color:var(--muted)}
.small{font-size:.85rem}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:36px;padding:6px 14px;border-radius:8px;border:1px solid var(--border);background:var(--panel);color:var(--text);font:inherit;text-decoration:none;cursor:pointer}
.btn:hover{background:var(--row)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-text);font-weight:600}
.btn.danger{background:var(--danger);border-color:var(--danger);color:var(--danger-text)}
.btn.ghost{border-color:transparent;background:none}
.btn.small{min-height:30px;padding:3px 10px;font-size:.88rem}
.btn[disabled]{opacity:.5;cursor:not-allowed}
.search{display:flex;gap:8px;margin-bottom:14px;max-width:560px}
input,select,textarea{font:inherit;color:var(--text);background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:8px 10px;width:100%;min-height:38px}
input[type=checkbox]{width:20px;height:20px;min-height:0;accent-color:var(--accent)}
input[aria-invalid=true],select[aria-invalid=true],textarea[aria-invalid=true]{border-color:var(--danger)}
textarea.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9rem}
.table-wrap{overflow-x:auto;background:var(--panel);border:1px solid var(--border);border-radius:10px;box-shadow:var(--shadow)}
table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--border);vertical-align:middle}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover{background:var(--row)}
th{font-size:.85rem;color:var(--muted);font-weight:600;white-space:nowrap}
th .sort{background:none;border:none;color:inherit;font:inherit;cursor:pointer;padding:2px 0}
.row-actions{text-align:right;white-space:nowrap}
.row-actions .btn{margin-left:6px}
.thumb{width:48px;height:32px;object-fit:cover;border-radius:4px;border:1px solid var(--border);display:block}
.badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:.8rem;border:1px solid var(--border)}
.badge.yes{color:var(--ok);border-color:var(--ok)}
.pager{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:14px}
.empty{background:var(--panel);border:1px dashed var(--border);border-radius:10px;padding:32px;text-align:center}
.record{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:20px;max-width:760px;box-shadow:var(--shadow)}
.record fieldset{border:none;margin:0;padding:0;min-width:0}
.field{margin-bottom:16px}
.field>label,.field>.label{display:block;font-weight:600;margin-bottom:4px}
.field.check{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.field.check>label{margin:0}
.field.check .help,.field.check .field-error{flex-basis:100%}
.req{color:var(--danger)}
.help{color:var(--muted);font-size:.85rem;margin:4px 0 0}
.field-error{color:var(--danger);font-size:.88rem;margin:4px 0 0;font-weight:600}
.readonly{display:block;padding:6px 0;color:var(--muted)}
.preview img{max-width:240px;max-height:160px;border-radius:8px;border:1px solid var(--border);display:block;margin-bottom:8px}
.preview span,.preview a{display:inline-block;margin-bottom:8px}
.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:8px}
.back{display:inline-block;margin-bottom:8px;text-decoration:none}
.error-summary{border:1px solid var(--danger);border-left-width:4px;background:var(--panel);padding:10px 14px;border-radius:8px;margin-bottom:16px}
.error-summary ul{margin:6px 0 0;padding-left:20px}
.toast{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);background:var(--text);color:var(--bg);padding:10px 16px;border-radius:10px;opacity:0;pointer-events:none;transition:opacity .2s;max-width:calc(100vw - 32px)}
.toast.show{opacity:1}
.toast.error{background:var(--danger);color:var(--danger-text)}
dialog{border:1px solid var(--border);border-radius:12px;background:var(--panel);color:var(--text);padding:20px;max-width:min(440px,calc(100vw - 32px))}
dialog::backdrop{background:rgba(0,0,0,.45)}
dialog h2{font-size:1.15rem;margin-bottom:8px}
@media (prefers-reduced-motion:reduce){.toast{transition:none}}
@media (max-width:760px){
  #menu{display:inline-block}
  .layout{grid-template-columns:minmax(0,1fr)}
  nav{display:none;border-right:none;border-bottom:1px solid var(--border)}
  nav.open{display:block}
  main{padding:16px}
  .record{padding:14px}
  .who{display:none}
}
`;

// Plain ES2020; String.raw keeps regex backslashes. Must not contain backticks, dollar-brace or a closing script tag.
const JS = String.raw`
(function () {
"use strict";
var BASE = location.pathname.replace(/\/+$/, "");
var API = BASE + "/api";
var PAGE_SIZE = 20;
var SKIP = {};
var LOGIN = document.body.getAttribute("data-login") || "";
var main = document.getElementById("main");
var navList = document.getElementById("nav-list");
var nav = document.getElementById("nav");
var menuBtn = document.getElementById("menu");
var toastEl = document.getElementById("toast");
var META = null;
var CSRF = "";
var relCache = new Map();
var seq = 0;
var toastTimer = 0;

function h(tag, attrs) {
  var el = document.createElement(tag);
  var a = attrs || {};
  Object.keys(a).forEach(function (k) {
    var v = a[k];
    if (v === undefined || v === null || v === false) return;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = String(v);
    else if (k.indexOf("on:") === 0) el.addEventListener(k.slice(3), v);
    else if (/^on/i.test(k)) return;
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = !!v;
    else el.setAttribute(k, v === true ? "" : String(v));
  });
  for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
  return el;
}
function append(el, c) {
  if (c === null || c === undefined || c === false) return;
  if (Array.isArray(c)) { c.forEach(function (x) { append(el, x); }); return; }
  el.append(c instanceof Node ? c : document.createTextNode(String(c)));
}
function enc(s) { return encodeURIComponent(String(s)); }
function hashFor() { return "#/" + Array.prototype.map.call(arguments, enc).join("/"); }
function fileUrl(res, id, field) { return API + "/" + enc(res) + "/" + enc(id) + "/files/" + enc(field); }

function toast(msg, kind) {
  toastEl.textContent = msg;
  toastEl.className = "toast show" + (kind === "error" ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { toastEl.className = "toast"; }, 4000);
}

function signedOut() {
  var kids = [h("h2", { tabindex: "-1", text: "Signed out" }), h("p", { text: "Your session has ended or you are not signed in." })];
  if (LOGIN) kids.push(h("a", { class: "btn primary", href: LOGIN + (LOGIN.indexOf("?") >= 0 ? "&" : "?") + "next=" + enc(location.pathname + location.hash) }, "Sign in"));
  main.replaceChildren(h("section", {}, kids));
}

function loadCsrf() {
  return fetch(API + "/_csrf", { credentials: "same-origin", headers: { accept: "application/json" } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) { if (d && d.token) CSRF = d.token; })
    .catch(function () {});
}

async function api(method, path, body, isForm) {
  function send() {
    var headers = { accept: "application/json" };
    if (method !== "GET") headers["x-csrf-token"] = CSRF;
    var payload;
    if (body !== undefined) {
      if (isForm) payload = body;
      else { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
    }
    return fetch(API + path, { method: method, headers: headers, body: payload, credentials: "same-origin" });
  }
  var res = await send();
  if (res.status === 403 && method !== "GET") {
    var p = await res.clone().json().catch(function () { return null; });
    if (p && p.code === "csrf_failed") { await loadCsrf(); res = await send(); }
  }
  if (res.status === 401) signedOut();
  var data = null;
  if (res.status !== 204) {
    var text = await res.text();
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = { detail: text }; }
  }
  if (!res.ok) {
    var err = new Error((data && (data.detail || data.title)) || ("Request failed (" + res.status + ")"));
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function singular(r) {
  var l = r.label;
  if (/ies$/i.test(l)) return l.slice(0, -3) + "y";
  if (/[^s]s$/i.test(l)) return l.slice(0, -1);
  return l;
}
function fieldLabel(r, name) {
  if (r.fields[name]) return r.fields[name].label;
  return { id: "ID", createdAt: "Created", updatedAt: "Updated" }[name] || name;
}
function titleOf(r, doc) {
  var v = doc[r.titleField];
  return v === undefined || v === null || v === "" ? String(doc.id) : String(v);
}
function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }
function fmtDate(v) {
  if (!v) return "";
  var d = new Date(v);
  return isNaN(d.getTime()) ? String(v) : d.toLocaleString();
}
function fmtSize(n) { return n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB"; }
function pad(n) { return String(n).padStart(2, "0"); }
function toLocalInput(v) {
  var d = new Date(v);
  if (isNaN(d.getTime())) return "";
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
}
function errorBox(e) { return h("div", { class: "error-summary", role: "alert" }, h("p", { text: e.message || String(e) })); }
function focusHeading(el) { try { el.focus({ preventScroll: false }); } catch (e) {} }

function relationItems(resource, labelField) {
  var key = resource + "\u0000" + labelField;
  if (!relCache.has(key)) {
    var res = META.resources.find(function (x) { return x.name === resource; });
    var p = !res || !res.permissions.list
      ? Promise.resolve(null)
      : api("GET", "/" + enc(resource) + "?limit=1000&sort=" + enc(labelField)).then(function (d) {
          return d.items.map(function (it) { return { id: it.id, label: it[labelField] === undefined || it[labelField] === null ? it.id : String(it[labelField]) }; });
        }).catch(function () { return null; });
    relCache.set(key, p);
  }
  return relCache.get(key);
}

function confirmDialog(title, text) {
  var d = document.getElementById("confirm");
  document.getElementById("confirm-title").textContent = title;
  document.getElementById("confirm-text").textContent = text;
  return new Promise(function (resolve) {
    d.returnValue = "";
    d.addEventListener("close", function () { resolve(d.returnValue === "ok"); }, { once: true });
    d.showModal();
  });
}

async function removeRecord(r, doc, after) {
  var ok = await confirmDialog("Delete " + singular(r).toLowerCase() + "?", "“" + titleOf(r, doc) + "” will be permanently deleted. This cannot be undone.");
  if (!ok) return;
  try {
    await api("DELETE", "/" + enc(r.name) + "/" + enc(doc.id));
    relCache.clear();
    toast("Deleted");
    after();
  } catch (e) { toast(e.message, "error"); }
}

function go(name, p) {
  var qs = new URLSearchParams();
  if (p.q) qs.set("q", p.q);
  if (p.sort) qs.set("sort", p.sort);
  if (p.page > 1) qs.set("page", String(p.page));
  var s = qs.toString();
  location.hash = hashFor("r", name) + (s ? "?" + s : "");
}

function cellContent(r, name, doc, labels) {
  var v = doc[name];
  var f = r.fields[name];
  if (name === "createdAt" || name === "updatedAt") return fmtDate(v);
  if (v === undefined || v === null) return "";
  if (!f) return String(v);
  switch (f.widget) {
    case "checkbox": return h("span", { class: v ? "badge yes" : "badge", text: v ? "Yes" : "No" });
    case "image": return h("img", { class: "thumb", src: fileUrl(r.name, doc.id, name) + "?v=" + enc(v), alt: "", loading: "lazy", width: "48", height: "32" });
    case "file": return "File";
    case "relation": {
      var hit = (labels[name] || []).find(function (o) { return o.id === v; });
      return hit ? hit.label : String(v);
    }
    case "datetime": return fmtDate(v);
    case "json": return truncate(JSON.stringify(v), 60);
    default: return truncate(String(v), 80);
  }
}

async function listView(r, params, my) {
  var q = params.get("q") || "";
  var sort = params.get("sort") || r.defaultSort || "";
  var page = Math.max(1, parseInt(params.get("page") || "1", 10) || 1);
  var qs = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String((page - 1) * PAGE_SIZE) });
  if (q) qs.set("q", q);
  if (sort) qs.set("sort", sort);

  var heading = h("h2", { tabindex: "-1", text: r.label });
  var count = h("span", { class: "muted", "aria-live": "polite" });
  var newBtn = r.permissions.create ? h("a", { class: "btn primary", href: hashFor("r", r.name, "new") }, "New " + singular(r).toLowerCase()) : null;
  var search = h("input", { type: "search", id: "q", name: "q", value: q, autocomplete: "off",
    placeholder: "Search" + (r.searchFields.length ? " " + r.searchFields.map(function (f) { return fieldLabel(r, f).toLowerCase(); }).join(", ") : "") + "…" });
  var form = h("form", { class: "search", role: "search", "on:submit": function (e) { e.preventDefault(); go(r.name, { q: search.value.trim(), sort: sort, page: 1 }); } },
    h("label", { for: "q", class: "sr-only", text: "Search " + r.label }), search,
    h("button", { class: "btn", type: "submit" }, "Search"),
    q ? h("a", { class: "btn ghost", href: hashFor("r", r.name) }, "Clear") : null);
  var results = h("div", { "aria-busy": "true" }, h("p", { class: "muted", text: "Loading…" }));
  main.replaceChildren(h("section", {}, h("div", { class: "toolbar" }, heading, count, h("span", { class: "spacer" }), newBtn), form, results));
  focusHeading(heading);

  var data;
  try { data = await api("GET", "/" + enc(r.name) + "?" + qs.toString()); }
  catch (e) { if (my === seq && e.status !== 401) results.replaceChildren(errorBox(e)); return; }
  var labels = {};
  await Promise.all(r.listFields.map(async function (name) {
    var f = r.fields[name];
    if (f && f.widget === "relation") labels[name] = await relationItems(f.relation.resource, f.relation.labelField);
  }));
  if (my !== seq) return;
  count.textContent = data.total + (data.total === 1 ? " record" : " records");
  results.removeAttribute("aria-busy");
  if (!data.items.length) {
    results.replaceChildren(h("div", { class: "empty" },
      h("p", { text: q ? "No " + r.label.toLowerCase() + " match “" + q + "”." : "No " + r.label.toLowerCase() + " yet." }),
      !q && r.permissions.create ? h("a", { class: "btn primary", href: hashFor("r", r.name, "new") }, "Create the first one") : null));
    return;
  }
  var cols = r.listFields;
  var headRow = h("tr", {}, cols.map(function (name) {
    var active = sort === name || sort === "-" + name;
    var desc = sort === "-" + name;
    var nextSort = active && !desc ? "-" + name : name;
    return h("th", { scope: "col", "aria-sort": active ? (desc ? "descending" : "ascending") : null },
      h("button", { type: "button", class: "sort", "on:click": function () { go(r.name, { q: q, sort: nextSort, page: 1 }); } },
        fieldLabel(r, name), h("span", { "aria-hidden": "true", text: active ? (desc ? " ▼" : " ▲") : "" })));
  }), h("th", { scope: "col" }, h("span", { class: "sr-only", text: "Actions" })));
  var rows = data.items.map(function (doc) {
    var tds = cols.map(function (name, i) {
      var content = cellContent(r, name, doc, labels);
      if (i === 0 && r.permissions.read) return h("td", {}, h("a", { href: hashFor("r", r.name, "edit", doc.id) }, content === "" ? "(untitled)" : content));
      return h("td", {}, content);
    });
    var label = titleOf(r, doc);
    tds.push(h("td", { class: "row-actions" },
      r.permissions.read ? h("a", { class: "btn small", href: hashFor("r", r.name, "edit", doc.id), "aria-label": (r.permissions.update ? "Edit " : "View ") + label }, r.permissions.update ? "Edit" : "View") : null,
      r.permissions.delete ? h("button", { type: "button", class: "btn small danger", "aria-label": "Delete " + label, "on:click": function () { removeRecord(r, doc, route); } }, "Delete") : null));
    return h("tr", {}, tds);
  });
  var pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
  var pager = h("nav", { class: "pager", "aria-label": "Pagination" },
    h("button", { type: "button", class: "btn", disabled: page <= 1, "on:click": function () { go(r.name, { q: q, sort: sort, page: page - 1 }); } }, "← Previous"),
    h("span", { text: "Page " + page + " of " + pages }),
    h("button", { type: "button", class: "btn", disabled: page >= pages, "on:click": function () { go(r.name, { q: q, sort: sort, page: page + 1 }); } }, "Next →"));
  results.replaceChildren(h("div", { class: "table-wrap" }, h("table", {}, h("caption", { class: "sr-only", text: r.label }), h("thead", {}, headRow), h("tbody", {}, rows))), pages > 1 ? pager : null);
}

async function renderField(r, name, f, doc, editing, refs, controls, uploads) {
  var schema = (r.schema.properties || {})[name] || {};
  var id = "f-" + name;
  var v = doc[name] !== undefined ? doc[name] : (!editing ? schema.default : undefined);
  var help = f.help ? h("p", { class: "help", id: id + "-help", text: f.help }) : null;
  var err = h("p", { class: "field-error", id: id + "-err", hidden: true });
  var described = (help ? id + "-help " : "") + id + "-err";
  var required = f.required && !f.readOnly;
  var lab = h("label", { for: id }, f.label, required ? h("span", { class: "req", "aria-hidden": "true", text: " *" }) : null);
  var common = { id: id, name: name, "aria-describedby": described, "aria-required": required ? "true" : null };
  function empty() { return editing ? (f.nullable ? null : "") : SKIP; }
  var input, get;

  if (f.readOnly && !f.upload) {
    var shown = v === undefined || v === null ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return h("div", { class: "field" }, h("span", { class: "label", id: id + "-label", text: f.label }), h("output", { class: "readonly", "aria-labelledby": id + "-label", text: shown }));
  }

  switch (f.widget) {
    case "checkbox":
      input = h("input", Object.assign({}, common, { type: "checkbox", checked: !!v }));
      refs[name] = { input: input, err: err };
      controls[name] = function () { return input.checked; };
      return h("div", { class: "field check" }, input, lab, help, err);
    case "number":
      input = h("input", Object.assign({}, common, { type: "number", step: schema.type === "integer" ? "1" : "any", min: schema.minimum, max: schema.maximum,
        inputmode: schema.type === "integer" ? "numeric" : "decimal", value: v === undefined || v === null ? "" : String(v) }));
      get = function () { return input.value === "" ? empty() : Number(input.value); };
      break;
    case "textarea":
    case "markdown":
      input = h("textarea", Object.assign({}, common, { rows: f.widget === "markdown" ? "12" : "5", class: f.widget === "markdown" ? "mono" : null, maxlength: schema.maxLength }));
      input.value = v === undefined || v === null ? "" : String(v);
      get = function () { return input.value === "" ? empty() : input.value; };
      break;
    case "select": {
      var opts = f.options || [];
      input = h("select", common, h("option", { value: "" }, "— Select —"), opts.map(function (o) { return h("option", { value: String(o) }, String(o)); }));
      input.value = v === undefined || v === null ? "" : String(v);
      get = function () {
        if (input.value === "") return empty();
        var hit = opts.find(function (o) { return String(o) === input.value; });
        return hit === undefined ? input.value : hit;
      };
      break;
    }
    case "date":
      input = h("input", Object.assign({}, common, { type: "date", value: v ? String(v).slice(0, 10) : "" }));
      get = function () { return input.value || empty(); };
      break;
    case "datetime":
      input = h("input", Object.assign({}, common, { type: "datetime-local", value: v ? toLocalInput(v) : "" }));
      get = function () { return input.value ? new Date(input.value).toISOString() : empty(); };
      break;
    case "relation": {
      var items = await relationItems(f.relation.resource, f.relation.labelField);
      if (items) {
        input = h("select", common, h("option", { value: "" }, "— None —"), items.map(function (o) { return h("option", { value: o.id }, o.label); }));
        input.value = v === undefined || v === null ? "" : String(v);
      } else {
        input = h("input", Object.assign({}, common, { type: "text", value: v === undefined || v === null ? "" : String(v) }));
      }
      get = function () { return input.value || empty(); };
      break;
    }
    case "image":
    case "file": {
      var isImg = f.widget === "image";
      var preview = h("div", { class: "preview" });
      if (v && editing) {
        if (isImg) preview.append(h("img", { src: fileUrl(r.name, doc.id, name) + "?v=" + enc(v), alt: "Current " + f.label.toLowerCase() }));
        else preview.append(h("a", { href: fileUrl(r.name, doc.id, name) }, "Download current file"));
      }
      input = h("input", Object.assign({}, common, { type: "file", accept: isImg ? "image/png,image/jpeg,image/webp,image/gif" : null }));
      var objectUrl = "";
      input.addEventListener("change", function () {
        var file = input.files && input.files[0];
        err.hidden = true;
        input.removeAttribute("aria-invalid");
        if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = ""; }
        if (!file) { delete uploads[name]; return; }
        if (file.size > r.maxFileSize) {
          delete uploads[name];
          err.textContent = "File is too large (max " + fmtSize(r.maxFileSize) + ").";
          err.hidden = false;
          input.setAttribute("aria-invalid", "true");
          return;
        }
        uploads[name] = file;
        if (isImg) {
          objectUrl = URL.createObjectURL(file);
          preview.replaceChildren(h("img", { src: objectUrl, alt: "Selected " + f.label.toLowerCase() + " preview" }));
        } else preview.replaceChildren(h("span", { text: file.name + " (" + fmtSize(file.size) + ")" }));
      });
      refs[name] = { input: input, err: err };
      return h("div", { class: "field" }, lab, preview, input, help, err);
    }
    case "json":
      input = h("textarea", Object.assign({}, common, { rows: "6", class: "mono", spellcheck: "false" }));
      input.value = v === undefined ? "" : JSON.stringify(v, null, 2);
      get = function () {
        if (input.value.trim() === "") return empty();
        try { return JSON.parse(input.value); } catch (e) { throw new Error("Invalid JSON"); }
      };
      break;
    default: {
      var type = schema.format === "email" ? "email" : schema.format === "url" ? "url" : "text";
      input = h("input", Object.assign({}, common, { type: type, maxlength: schema.maxLength, value: v === undefined || v === null ? "" : String(v) }));
      get = function () { return input.value === "" ? empty() : input.value; };
    }
  }
  refs[name] = { input: input, err: err };
  controls[name] = get;
  return h("div", { class: "field" }, lab, input, help, err);
}

async function formView(r, id, my) {
  var editing = id !== undefined;
  var canWrite = editing ? r.permissions.update : r.permissions.create;
  var back = h("a", { class: "back", href: hashFor("r", r.name) }, "← " + r.label);
  var heading = h("h2", { tabindex: "-1", text: (editing ? (canWrite ? "Edit " : "View ") : "New ") + singular(r).toLowerCase() });
  main.replaceChildren(h("section", {}, back, h("div", { class: "toolbar" }, heading), h("p", { class: "muted", text: "Loading…" })));
  var doc = {};
  if (editing) {
    try { doc = await api("GET", "/" + enc(r.name) + "/" + enc(id)); }
    catch (e) { if (my === seq && e.status !== 401) main.replaceChildren(h("section", {}, back, h("div", { class: "toolbar" }, heading), errorBox(e))); return; }
  }
  var refs = {}, controls = {}, uploads = {};
  var els = [];
  var names = Object.keys(r.fields);
  for (var i = 0; i < names.length; i++) {
    var f = r.fields[names[i]];
    if (!editing && f.readOnly && !f.upload) continue;
    els.push(await renderField(r, names[i], f, doc, editing, refs, controls, uploads));
  }
  if (my !== seq) return;
  var summary = h("div", { class: "error-summary", role: "alert", tabindex: "-1", hidden: true });
  var save = h("button", { type: "submit", class: "btn primary" }, editing ? "Save changes" : "Create");
  var fieldset = h("fieldset", { disabled: !canWrite }, h("legend", { class: "sr-only", text: singular(r) + " fields" }), els);

  function clearErrors() {
    summary.hidden = true;
    summary.replaceChildren();
    Object.keys(refs).forEach(function (k) { refs[k].err.hidden = true; refs[k].err.textContent = ""; refs[k].input.removeAttribute("aria-invalid"); });
  }
  function showIssues(issues) {
    var items = [];
    var first = null;
    issues.forEach(function (iss) {
      var path = iss.path || [];
      var name = path[0] === "body" ? path[1] : path[0];
      var ref = refs[name];
      var text = (r.fields[name] ? r.fields[name].label + ": " : "") + iss.message;
      items.push(h("li", { text: text }));
      if (ref) {
        ref.err.textContent = iss.message;
        ref.err.hidden = false;
        ref.input.setAttribute("aria-invalid", "true");
        if (!first) first = ref.input;
      }
    });
    summary.replaceChildren(h("p", { text: "Please correct the following:" }), h("ul", {}, items));
    summary.hidden = false;
    (first || summary).focus();
  }

  var form = h("form", { class: "record", novalidate: true, "on:submit": async function (e) {
    e.preventDefault();
    if (!canWrite) return;
    clearErrors();
    var body = {};
    var local = [];
    Object.keys(controls).forEach(function (name) {
      try { var val = controls[name](); if (val !== SKIP) body[name] = val; }
      catch (x) { local.push({ path: ["body", name], message: x.message }); }
    });
    Object.keys(refs).forEach(function (name) {
      if (refs[name].input.getAttribute("type") === "file" && refs[name].input.files && refs[name].input.files[0] && !uploads[name]) local.push({ path: ["body", name], message: "File is too large (max " + fmtSize(r.maxFileSize) + ")." });
    });
    if (local.length) { showIssues(local); return; }
    save.disabled = true;
    save.setAttribute("aria-busy", "true");
    var saved = null;
    try {
      saved = editing ? await api("PATCH", "/" + enc(r.name) + "/" + enc(id), body) : await api("POST", "/" + enc(r.name), body);
      var fields = Object.keys(uploads);
      for (var j = 0; j < fields.length; j++) {
        var fd = new FormData();
        fd.append("file", uploads[fields[j]]);
        try {
          saved = (await api("POST", "/" + enc(r.name) + "/" + enc(saved.id) + "/files/" + enc(fields[j]), fd, true)).item;
        } catch (x) {
          var msg = x.status === 413 ? "File is too large" : x.data && x.data.issues && x.data.issues[0] ? x.data.issues[0].message : x.message;
          if (!editing) {
            toast("Saved, but the upload failed: " + msg, "error");
            location.hash = hashFor("r", r.name, "edit", saved.id);
            return;
          }
          showIssues([{ path: ["body", fields[j]], message: msg }]);
          return;
        }
      }
      relCache.clear();
      toast(editing ? "Saved" : "Created");
      location.hash = hashFor("r", r.name);
    } catch (x) {
      if (x.status === 422 && x.data && Array.isArray(x.data.issues)) showIssues(x.data.issues);
      else if (x.status !== 401) toast(x.message, "error");
    } finally {
      save.disabled = false;
      save.removeAttribute("aria-busy");
    }
  } }, summary, fieldset, h("div", { class: "actions" },
    canWrite ? save : null,
    h("a", { class: "btn", href: hashFor("r", r.name) }, canWrite ? "Cancel" : "Back"),
    editing && r.permissions.delete ? h("button", { type: "button", class: "btn danger", "on:click": function () { removeRecord(r, doc, function () { location.hash = hashFor("r", r.name); }); } }, "Delete") : null));
  var metaLine = editing ? h("p", { class: "muted small", text: "ID " + doc.id + (doc.createdAt ? " · created " + fmtDate(doc.createdAt) : "") + (doc.updatedAt ? " · updated " + fmtDate(doc.updatedAt) : "") }) : null;
  main.replaceChildren(h("section", {}, back, h("div", { class: "toolbar" }, heading), form, metaLine));
  focusHeading(heading);
}

function parseHash() {
  var raw = location.hash.slice(1) || "/";
  var qi = raw.indexOf("?");
  var path = qi >= 0 ? raw.slice(0, qi) : raw;
  var parts = path.split("/").filter(Boolean).map(function (p) { try { return decodeURIComponent(p); } catch (e) { return p; } });
  return { parts: parts, params: new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : "") };
}

function setNav(active) {
  navList.querySelectorAll("a").forEach(function (a) {
    if (a.getAttribute("data-name") === active) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
}
function closeNav() { nav.classList.remove("open"); menuBtn.setAttribute("aria-expanded", "false"); }

function route() {
  if (!META) return;
  var my = ++seq;
  var h0 = parseHash();
  var parts = h0.parts;
  closeNav();
  if (parts[0] !== "r" || !parts[1]) {
    if (META.resources.length) location.replace(hashFor("r", META.resources[0].name));
    return;
  }
  var r = META.resources.find(function (x) { return x.name === parts[1]; });
  setNav(r ? r.name : "");
  if (!r) { main.replaceChildren(h("section", {}, h("h2", { text: "Not found" }), h("p", { text: "This resource does not exist." }))); return; }
  if (parts[2] === "new") {
    if (!r.permissions.create) { main.replaceChildren(errorBox(new Error("You may not create " + r.label.toLowerCase() + "."))); return; }
    formView(r, undefined, my);
  } else if (parts[2] === "edit" && parts[3]) formView(r, parts[3], my);
  else listView(r, h0.params, my);
}

function themeLabel() {
  var cur = document.documentElement.getAttribute("data-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.getElementById("theme").setAttribute("aria-label", cur === "dark" ? "Switch to light theme" : "Switch to dark theme");
  return cur;
}
function initTheme() {
  var saved = null;
  try { saved = localStorage.getItem("miu-admin-theme"); } catch (e) {}
  if (saved === "dark" || saved === "light") document.documentElement.setAttribute("data-theme", saved);
  themeLabel();
  document.getElementById("theme").addEventListener("click", function () {
    var next = themeLabel() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("miu-admin-theme", next); } catch (e) {}
    themeLabel();
  });
  menuBtn.addEventListener("click", function () {
    var open = !nav.classList.contains("open");
    nav.classList.toggle("open", open);
    menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) { var a = nav.querySelector("a"); if (a) a.focus(); }
  });
}

async function boot() {
  initTheme();
  try { META = await api("GET", "/_meta"); }
  catch (e) { if (e.status !== 401) main.replaceChildren(errorBox(e)); return; }
  document.getElementById("who").textContent = META.user.name;
  navList.replaceChildren.apply(navList, META.resources.map(function (r) {
    return h("li", {}, h("a", { href: hashFor("r", r.name), "data-name": r.name }, r.label));
  }));
  await loadCsrf();
  window.addEventListener("hashchange", route);
  route();
}
boot();
})();
`;
