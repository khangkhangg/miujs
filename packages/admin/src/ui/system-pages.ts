// System screens: one card per plugin, and a page per plugin with a tab per manage() section
// (stats, tables, lists with paging/search/filters and row actions, a settings form generated
// from the schema, action forms). Every read and write is a sub-request to the System API
// (`<apiBase>/_admin/system`), so its permission checks, validation and audit apply unchanged.
// Plugin data is untrusted: it only ever reaches the page through escaping `html` templates.

import type { Context } from "miujs";
import { html, raw, type HtmlString } from "@miujs/web";
import { schemaFormLib, type SchemaField } from "./client/schema-form.ts";
import { pageData, type Core, type PageData } from "./core.ts";
import type { FormValues } from "./form.ts";
import { redirect, sub, type SubResponse } from "./http.ts";
import { alert, page } from "./layout.ts";

const schemaForm = schemaFormLib();
const REDACTED = "[REDACTED]";

type Value = string | number | boolean | null;
interface Column {
  key: string;
  label: string;
  type?: string;
}
interface ActionMeta {
  name: string;
  title: string;
  description: string | null;
  danger: boolean;
  input: Record<string, unknown> | null;
  allowed: boolean;
}
interface ListMeta {
  name: string;
  title: string;
  columns: Column[];
  idKey: string;
  searchable: boolean;
  filters: { key: string; label: string; options: string[] }[];
  rowActions: ActionMeta[];
}
interface SectionData {
  plugin: string;
  section: { id: string; title: string; description: string | null };
  status: { stats?: { label: string; value: Value; hint?: string; tone?: string; type?: string }[]; tables?: { title: string; columns: Column[]; rows: Record<string, Value>[] }[] } | null;
  statusError: string | null;
  lists: ListMeta[];
  settings: { schema: Record<string, unknown>; canWrite: boolean } | null;
  actions: ActionMeta[];
}
interface PluginSummary {
  name: string;
  builtin: boolean;
  sections: { id: string; title: string; description: string | null; status: boolean }[];
}

const api = (core: Core, path = "") => `${core.apiBase}/_admin/system${path}`;
const seg = encodeURIComponent;
const get = (core: Core, ctx: Context, path: string) => sub(core.app, ctx, "GET", api(core, path), { org: null });
const send = (core: Core, ctx: Context, method: string, path: string, body: unknown) => sub(core.app, ctx, method, api(core, path), { body, org: null });

function apiMessages(res: SubResponse): string[] {
  const e = res.data?.error;
  if (!e) return ["The request failed."];
  return [[e.message, e.fix].filter(Boolean).join(" ")];
}

// ------------------------------------------------------------------------------- values

function bytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (Math.abs(v) >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : Math.round(v * 10) / 10} ${units[i]}`;
}

function duration(ms: number): string {
  if (Math.abs(ms) < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (Math.abs(s) < 60) return `${Math.round(s * 10) / 10} s`;
  if (Math.abs(s) < 3600) return `${Math.round((s / 60) * 10) / 10} min`;
  if (Math.abs(s) < 86400) return `${Math.round((s / 3600) * 10) / 10} h`;
  return `${Math.round((s / 86400) * 10) / 10} d`;
}

function date(v: Value): string {
  const d = typeof v === "number" ? new Date(v) : typeof v === "string" ? new Date(v) : null;
  if (!d || Number.isNaN(d.getTime())) return String(v);
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** One cell or stat value, escaped, formatted by the column type. */
export function formatValue(v: unknown, type: string | undefined): HtmlString | string {
  if (v === null || v === undefined || v === "") return html`<span class="muted">—</span>`;
  if (typeof v === "object") return html`<code>${JSON.stringify(v)}</code>`;
  const value = v as Value;
  switch (type) {
    case "bytes":
      return typeof value === "number" ? bytes(value) : String(value);
    case "duration":
      return typeof value === "number" ? duration(value) : String(value);
    case "date":
      return date(value);
    case "boolean":
      return value === true ? "Yes" : value === false ? "No" : String(value);
    case "code":
      return html`<code>${String(value)}</code>`;
    default:
      return typeof value === "boolean" ? (value ? "Yes" : "No") : String(value);
  }
}

const TONES = new Set(["good", "warning", "critical"]);

function statsList(stats: NonNullable<SectionData["status"]>["stats"]): HtmlString | string {
  if (!stats?.length) return "";
  return html`<dl class="stats">${stats.map(
    (s) => html`<div class="stat${s.tone && TONES.has(s.tone) ? ` tone-${s.tone}` : ""}"><dt>${s.label}</dt><dd${s.hint ? html` title="${s.hint}"` : ""}>${formatValue(s.value, s.type)}</dd></div>`,
  )}</dl>`;
}

function dataTable(columns: Column[], rows: Record<string, unknown>[], extra?: { label: string; cell: (row: Record<string, unknown>) => HtmlString | string }): HtmlString {
  return html`<div class="table-wrap"><table><thead><tr>${columns.map((c) => html`<th scope="col">${c.label}</th>`)}${extra ? html`<th scope="col">${extra.label}</th>` : ""}</tr></thead><tbody>${
    rows.length
      ? rows.map((r) => html`<tr>${columns.map((c) => html`<td>${formatValue(r?.[c.key], c.type)}</td>`)}${extra ? html`<td>${extra.cell(r)}</td>` : ""}</tr>`)
      : html`<tr><td colspan="${columns.length + (extra ? 1 : 0)}" class="muted">Nothing here.</td></tr>`
  }</tbody></table></div>`;
}

// ------------------------------------------------------------------------------- forms

/** Form controls for a JSON schema (as made by `t`), named `in.<field>`. */
function controls(idPrefix: string, fields: SchemaField[], values: Record<string, unknown>, secrets: Set<string> = new Set()): HtmlString[] {
  const current = schemaForm.toForm(fields, values);
  return fields.map((f) => {
    const id = `${idPrefix}-${f.name || "value"}`;
    const name = `in.${f.name}`;
    const label = html`<label for="${id}">${f.name || "Input"}${f.required ? html` <span class="req" aria-hidden="true">*</span>` : ""}</label>`;
    const help = f.description ? html`<p class="help">${f.description}</p>` : "";
    const v = current[f.name] ?? "";
    if (f.kind === "boolean") {
      return html`<div class="field check"><input type="checkbox" id="${id}" name="${name}" value="true"${v === "true" ? raw(" checked") : ""}>${label}${help}</div>`;
    }
    let control: HtmlString;
    if (f.kind === "enum") {
      control = html`<select id="${id}" name="${name}">${f.required ? "" : html`<option value=""></option>`}${(f.options ?? []).map((o) => html`<option value="${o}"${o === v ? raw(" selected") : ""}>${o}</option>`)}</select>`;
    } else if (f.kind === "json") {
      control = html`<textarea id="${id}" name="${name}" rows="3" class="mono">${v}</textarea>`;
    } else if (secrets.has(f.name)) {
      control = html`<input type="password" id="${id}" name="${name}" value="" autocomplete="off" placeholder="unchanged">`;
    } else {
      control = html`<input type="${f.kind === "text" ? "text" : "number"}" id="${id}" name="${name}" value="${v}"${f.kind === "number" ? raw(' step="any"') : ""}${f.required ? raw(" required") : ""}>`;
    }
    return html`<div class="field">${label}${control}${secrets.has(f.name) ? html`<p class="help">Leave empty to keep the current value.</p>` : help}</div>`;
  });
}

const formStrings = (form: FormValues): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(form)) if (k.startsWith("in.") && typeof v === "string") out[k.slice(3)] = v;
  return out;
};

/** A row action's input fields without `id`: the API merges the row id from the URL. */
const ROW_ID = "id";
const inputFields = (schema: Record<string, unknown> | null, row: boolean): SchemaField[] => {
  if (!schema) return [];
  const fields = schemaForm.fields(schema);
  return row ? fields.filter((f) => f.name !== ROW_ID) : fields;
};

function readInput(schema: Record<string, unknown> | null, form: FormValues, row: boolean): { value: unknown; errors: string[] } {
  if (!schema) return { value: {}, errors: [] };
  const fields = inputFields(schema, row);
  const out = schemaForm.coerce(fields, formStrings(form));
  const errors = out.errors.map((e) => `${e.name || "Input"} ${e.message}`);
  return { value: fields.length === 1 && fields[0].name === "" ? out.value[""] : out.value, errors };
}

/** An action's form; `inline` (a list row's action) never asks for the row id. */
function actionForm(path: string, a: ActionMeta, idPrefix: string, inline = false): HtmlString {
  const fields = inputFields(a.input, inline);
  const button = a.danger ? html`<button type="submit" class="danger" data-confirm="${a.title}?">${a.title}</button>` : html`<button type="submit">${a.title}</button>`;
  return html`<form method="post" action="${path}" class="${inline ? "toolbar" : "panel action"}">${inline ? "" : html`<h3>${a.title}</h3>${a.description ? html`<p class="help">${a.description}</p>` : ""}`}${controls(idPrefix, fields, {})}${button}</form>`;
}

// ------------------------------------------------------------------------------- pages

function systemPage(core: Core, ctx: Context, d: PageData, title: string, body: HtmlString, status = 200): Response {
  return page(core.shell, ctx, { title, active: "system", status, ...d, body });
}

function failPage(core: Core, ctx: Context, d: PageData, res: SubResponse, title = "System"): Response {
  const status = res.status >= 400 ? res.status : 500;
  const heading = status === 403 ? "Not allowed" : status === 404 ? "Not found" : title;
  return systemPage(core, ctx, d, heading, html`<h1>${heading}</h1>${alert(apiMessages(res))}<p><a href="${core.path}/system">Back to System</a></p>`, status);
}

export async function overview(core: Core, ctx: Context): Promise<Response> {
  const [d, res] = await Promise.all([pageData(core, ctx), get(core, ctx, "")]);
  if (!res.ok) return failPage(core, ctx, d, res);
  const plugins = (res.data.plugins ?? []) as PluginSummary[];
  const statuses = await Promise.all(
    plugins.map((p) => Promise.all(p.sections.map((s) => (s.status ? get(core, ctx, `/${seg(p.name)}/${seg(s.id)}`) : Promise.resolve(null))))),
  );
  const cards = plugins.map((p, i) => {
    const href = p.sections.length ? `${core.path}/system/${seg(p.name)}/${seg(p.sections[0].id)}` : `${core.path}/system/${seg(p.name)}`;
    return html`<section class="panel plugin-card" aria-labelledby="pc-${i}"><h2 id="pc-${i}"><a href="${href}">${p.name}</a>${p.builtin ? html` <span class="chip">built-in</span>` : ""}</h2>${
      p.sections.length
        ? p.sections.map((s, j) => {
            const st = statuses[i][j];
            const data = st?.ok ? (st.data as SectionData) : null;
            return html`<h3><a href="${core.path}/system/${seg(p.name)}/${seg(s.id)}">${s.title}</a></h3>${data?.status ? statsList(data.status.stats) : st && !st.ok ? html`<p class="muted">Status unavailable.</p>` : ""}`;
          })
        : html`<p class="muted">No management sections.</p>`
    }</section>`;
  });
  const body = html`<h1>System</h1><p class="help">Every plugin of this app. Open one to see its status, lists, settings and actions.</p><div class="plugin-cards">${cards}</div>`;
  return systemPage(core, ctx, d, "System", body);
}

export async function pluginPage(core: Core, ctx: Context, plugin: string): Promise<Response> {
  const [d, res] = await Promise.all([pageData(core, ctx), get(core, ctx, `/${seg(plugin)}`)]);
  if (!res.ok) return failPage(core, ctx, d, res);
  const sections = res.data.sections as PluginSummary["sections"];
  if (sections.length) return redirect(`${core.path}/system/${seg(plugin)}/${seg(sections[0].id)}`);
  const body = html`<p><a href="${core.path}/system">System</a> ›</p><h1>${res.data.name}</h1><p class="muted">This plugin has no management sections.</p>${
    res.data.inspect !== null && res.data.inspect !== undefined ? html`<section class="panel"><h2>inspect()</h2><pre class="mono">${JSON.stringify(res.data.inspect, null, 2)}</pre></section>` : ""
  }`;
  return systemPage(core, ctx, d, res.data.name, body);
}

interface Notice {
  kind: "ok" | "error";
  messages: string[];
  status: number;
}

/** Page query keys of one list: `<list>.search`, `<list>.cursor`, `<list>.limit`, `<list>.f.<key>`. */
function listQuery(l: ListMeta, url: URL): { api: URLSearchParams; page: URLSearchParams; filters: Record<string, string>; search: string; cursor: string } {
  const p = (k: string) => url.searchParams.get(`${l.name}.${k}`) ?? "";
  const filters: Record<string, string> = {};
  for (const f of l.filters) {
    const v = p(`f.${f.key}`);
    if (v) filters[f.key] = v;
  }
  const api = new URLSearchParams();
  const pageQ = new URLSearchParams();
  const limit = p("limit");
  if (limit) {
    api.set("limit", limit);
    pageQ.set(`${l.name}.limit`, limit);
  }
  const search = p("search");
  if (search) {
    api.set("search", search);
    pageQ.set(`${l.name}.search`, search);
  }
  if (Object.keys(filters).length) {
    api.set("filters", JSON.stringify(filters));
    for (const [k, v] of Object.entries(filters)) pageQ.set(`${l.name}.f.${k}`, v);
  }
  const cursor = p("cursor");
  if (cursor) api.set("cursor", cursor);
  return { api, page: pageQ, filters, search, cursor };
}

async function listPanel(core: Core, ctx: Context, base: string, apiPath: string, l: ListMeta, i: number): Promise<HtmlString> {
  const q = listQuery(l, ctx.url);
  const res = await get(core, ctx, `${apiPath}/lists/${seg(l.name)}${q.api.toString() ? `?${q.api}` : ""}`);
  const form = html`<form method="get" action="${base}" class="toolbar">${
    l.searchable ? html`<label for="ls-${i}" class="sr-only">Search ${l.title}</label><input type="search" id="ls-${i}" name="${l.name}.search" value="${q.search}" placeholder="Search">` : ""
  }${l.filters.map(
    (f, j) =>
      html`<label for="lf-${i}-${j}">${f.label}</label><select id="lf-${i}-${j}" name="${l.name}.f.${f.key}"><option value="">All</option>${f.options.map((o) => html`<option value="${o}"${q.filters[f.key] === o ? raw(" selected") : ""}>${o}</option>`)}</select>`,
  )}${l.searchable || l.filters.length ? html`<button type="submit">Apply</button>` : ""}</form>`;
  if (!res.ok) return html`<section class="panel" aria-labelledby="lh-${i}"><h2 id="lh-${i}">${l.title}</h2>${form}${alert(apiMessages(res))}</section>`;
  const rows = (res.data.rows ?? []) as Record<string, unknown>[];
  const allowed = l.rowActions.filter((a) => a.allowed);
  const extra = allowed.length
    ? {
        label: "Actions",
        cell: (row: Record<string, unknown>) => {
          const id = row?.[l.idKey];
          if (id === null || id === undefined || id === "") return "";
          const idText = String(id);
          return html`${allowed.map((a, k) => actionForm(`${base}/lists/${seg(l.name)}/${seg(idText)}/actions/${seg(a.name)}`, a, `ra-${i}-${k}-${seg(idText)}`, true))}`;
        },
      }
    : undefined;
  const next = typeof res.data.next === "string" ? res.data.next : null;
  const nextQ = new URLSearchParams(q.page);
  if (next) nextQ.set(`${l.name}.cursor`, next);
  const pager = html`<nav class="pager" aria-label="${l.title} pages">${q.cursor ? html`<a class="btn" href="${base}${q.page.toString() ? `?${q.page}` : ""}">First page</a>` : ""}${
    next ? html`<a class="btn" href="${base}?${nextQ}">Next</a>` : ""
  }</nav>`;
  return html`<section class="panel" aria-labelledby="lh-${i}"><h2 id="lh-${i}">${l.title}</h2>${form}${dataTable(l.columns, rows, extra)}${pager}</section>`;
}

async function settingsPanel(core: Core, ctx: Context, base: string, apiPath: string, s: NonNullable<SectionData["settings"]>): Promise<HtmlString> {
  const res = await get(core, ctx, `${apiPath}/settings`);
  if (!res.ok) return html`<section class="panel"><h2>Settings</h2>${alert(apiMessages(res))}</section>`;
  const value = (res.data.value ?? {}) as Record<string, unknown>;
  const fields = schemaForm.fields(s.schema);
  if (!s.canWrite) {
    return html`<section class="panel" aria-labelledby="set-h"><h2 id="set-h">Settings</h2><dl class="meta">${fields.map((f) => html`<dt>${f.name}</dt><dd>${formatValue(value[f.name] as Value, undefined)}</dd>`)}</dl></section>`;
  }
  const secrets = new Set(Object.keys(value).filter((k) => value[k] === REDACTED));
  return html`<section class="panel" aria-labelledby="set-h"><h2 id="set-h">Settings</h2><form method="post" action="${base}/settings">${controls("set", fields, value, secrets)}<button type="submit" class="primary">Save settings</button></form></section>`;
}

/** The section tab of a plugin page, with an optional notice from an action or a save. */
export async function sectionPage(core: Core, ctx: Context, plugin: string, section: string, notice?: Notice): Promise<Response> {
  const apiPath = `/${seg(plugin)}/${seg(section)}`;
  const [d, pl, res] = await Promise.all([pageData(core, ctx), get(core, ctx, `/${seg(plugin)}`), get(core, ctx, apiPath)]);
  if (!pl.ok) return failPage(core, ctx, d, pl);
  if (!res.ok) return failPage(core, ctx, d, res);
  const data = res.data as SectionData;
  const sections = pl.data.sections as PluginSummary["sections"];
  const base = `${core.path}/system${apiPath}`;
  const tabs = html`<nav class="tabs" aria-label="Sections">${sections.map(
    (x) => html`<a href="${core.path}/system/${seg(plugin)}/${seg(x.id)}"${x.id === section ? html` aria-current="page"` : ""}>${x.title}</a>`,
  )}</nav>`;
  const status = data.status;
  const lists = await Promise.all(data.lists.map((l, i) => listPanel(core, ctx, base, apiPath, l, i)));
  const settings = data.settings ? await settingsPanel(core, ctx, base, apiPath, data.settings) : "";
  const actions = data.actions.filter((a) => a.allowed);
  const body = html`<p><a href="${core.path}/system">System</a> › ${pl.data.name}</p><h1>${pl.data.name}: ${data.section.title}</h1>${tabs}${
    notice ? alert(notice.messages, notice.kind) : ""
  }${data.section.description ? html`<p class="help">${data.section.description}</p>` : ""}${data.statusError ? alert(data.statusError) : ""}${status ? statsList(status.stats) : ""}${(status?.tables ?? []).map(
    (tb) => html`<section class="panel"><h2>${tb.title}</h2>${dataTable(tb.columns ?? [], tb.rows ?? [])}</section>`,
  )}${lists}${settings}${
    actions.length ? html`<section aria-labelledby="act-h"><h2 id="act-h">Actions</h2>${actions.map((a, i) => actionForm(`${base}/actions/${seg(a.name)}`, a, `act-${i}`))}</section>` : ""
  }`;
  return systemPage(core, ctx, d, `${pl.data.name}: ${data.section.title}`, body, notice?.status ?? 200);
}

function confirmPage(core: Core, ctx: Context, d: PageData, question: string, form: FormValues, back: string): Response {
  const keep = Object.entries(form).filter(([k, v]) => k.startsWith("in.") && typeof v === "string");
  const body = html`<h1>${question}</h1><form method="post" action="${ctx.url.pathname}" class="panel">${keep.map(([k, v]) => html`<input type="hidden" name="${k}" value="${v as string}">`)}<input type="hidden" name="confirmed" value="1"><p>This cannot be undone.</p><div class="toolbar"><button type="submit" class="danger">Yes, continue</button><a class="btn" href="${back}">Cancel</a></div></form>`;
  return systemPage(core, ctx, d, question, body);
}

function resultText(result: unknown): string {
  if (result === null || result === undefined) return "Done.";
  const text = typeof result === "string" ? result : JSON.stringify(result);
  return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
}

/** POST from an action form (row: a list row's action). Danger actions are confirmed first. */
export async function runAction(core: Core, ctx: Context, plugin: string, section: string, action: string, row: { list: string; id: string } | null): Promise<Response> {
  const apiPath = `/${seg(plugin)}/${seg(section)}`;
  const res = await get(core, ctx, apiPath);
  if (!res.ok) return failPage(core, ctx, await pageData(core, ctx), res);
  const data = res.data as SectionData;
  const pool = row ? (data.lists.find((l) => l.name === row.list)?.rowActions ?? []) : data.actions;
  const a = pool.find((x) => x.name === action);
  if (!a) return sectionPage(core, ctx, plugin, section, { kind: "error", messages: [`There is no action "${action}" here.`], status: 404 });
  const form = (ctx.body as FormValues) ?? {};
  if (a.danger && form.confirmed !== "1") return confirmPage(core, ctx, await pageData(core, ctx), `${a.title}?`, form, `${core.path}/system${apiPath}`);
  const input = readInput(a.input, form, row !== null);
  if (input.errors.length) return sectionPage(core, ctx, plugin, section, { kind: "error", messages: input.errors, status: 400 });
  const path = row ? `${apiPath}/lists/${seg(row.list)}/${seg(row.id)}/actions/${seg(a.name)}` : `${apiPath}/actions/${seg(a.name)}`;
  const out = await send(core, ctx, "POST", path, input.value);
  if (!out.ok) return sectionPage(core, ctx, plugin, section, { kind: "error", messages: apiMessages(out), status: out.status });
  return sectionPage(core, ctx, plugin, section, { kind: "ok", messages: [`${a.title}: ${resultText(out.data?.result)}`], status: 200 });
}

function allowsNull(s: unknown): boolean {
  if (!s || typeof s !== "object") return false;
  const o = s as { type?: unknown; anyOf?: unknown[] };
  return o.type === "null" || (Array.isArray(o.anyOf) && o.anyOf.some(allowsNull));
}

/**
 * POST from the settings form. Unchecked boxes are false, an empty secret keeps its value, an
 * empty nullable field is null. Unions (e.g. `number | false`) are JSON fields: `false`, `5000`.
 */
export async function saveSettings(core: Core, ctx: Context, plugin: string, section: string): Promise<Response> {
  const apiPath = `/${seg(plugin)}/${seg(section)}`;
  const cur = await get(core, ctx, `${apiPath}/settings`);
  if (!cur.ok) return failPage(core, ctx, await pageData(core, ctx), cur);
  const fields = schemaForm.fields(cur.data.schema);
  const form = (ctx.body as FormValues) ?? {};
  const out = schemaForm.coerce(fields, formStrings(form));
  if (out.errors.length) return sectionPage(core, ctx, plugin, section, { kind: "error", messages: out.errors.map((e) => `${e.name} ${e.message}`), status: 400 });
  const value: Record<string, unknown> = { ...out.value };
  const current = (cur.data.value ?? {}) as Record<string, unknown>;
  const props = ((cur.data.schema as { properties?: Record<string, unknown> })?.properties ?? {}) as Record<string, unknown>;
  for (const f of fields) {
    if (f.name in value) continue;
    if (current[f.name] === REDACTED) value[f.name] = REDACTED;
    else if (f.kind === "boolean") value[f.name] = false;
    // An empty field of a nullable setting means null ("use the default").
    else if (allowsNull(props[f.name])) value[f.name] = null;
  }
  const res = await send(core, ctx, "PUT", `${apiPath}/settings`, value);
  if (!res.ok) return sectionPage(core, ctx, plugin, section, { kind: "error", messages: apiMessages(res), status: res.status });
  return sectionPage(core, ctx, plugin, section, { kind: "ok", messages: ["Settings saved. Other instances apply them within the settings TTL (30 s by default)."], status: 200 });
}
