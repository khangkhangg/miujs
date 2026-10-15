// Resource screens: overview, list (table / kanban / calendar), record form, import wizard,
// confirmations. Data comes from the resource API through sub-requests, so the API's
// permission checks, tenant scoping, validation and row policies apply unchanged.

import type { Context } from "miujs";
import { html, raw, type HtmlString } from "@miujs/web";
import type { ActionMeta, FieldMeta, ResourceMeta } from "../meta.ts";
import { monthGrid, monthRange, parseMonth } from "./calendar.ts";
import { filterLib } from "./client/filters.ts";
import { schemaFormLib } from "./client/schema-form.ts";
import { pageData, type Core, type PageData } from "./core.ts";
import { badge, changedOnly, displayValue, fieldErrors, formToBody, renderField, richText, writable, type FormValues } from "./form.ts";
import { orgOf, redirect, safeNext, sub } from "./http.ts";
import { alert, page } from "./layout.ts";

const filters = filterLib();
const schemaForm = schemaFormLib();

const plural = (r: ResourceMeta, n: number) => (n === 1 ? r.singular.toLowerCase() : r.label.toLowerCase());
const qs = (s: string) => (s ? `?${s}` : "");
const asList = (v: unknown): string[] => (v === undefined || v === null ? [] : (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === "string" && x !== ""));

function titleOf(r: ResourceMeta, rec: Record<string, unknown>): string {
  const v = rec[r.titleField];
  return v === null || v === undefined || v === "" ? String(rec.id) : String(v);
}

export function errorPage(core: Core, ctx: Context, d: PageData, status: number, title: string, messages: string[] | string, active?: string): Response {
  return page(core.shell, ctx, { title, active, status, ...d, body: html`<h1>${title}</h1>${alert(messages)}` });
}

const apiMessage = (data: any) => (data?.error ? [data.error.message, data.error.fix].filter(Boolean).join(" ") : "The request failed.");

/** Finds a resource the user may see, or the error response to send. */
export async function resourcePage(core: Core, ctx: Context, name: string): Promise<{ d: PageData; r: ResourceMeta } | Response> {
  const d = await pageData(core, ctx);
  const r = d.resources.find((x) => x.name === name);
  if (r) return { d, r };
  const exists = core.admin.schema().resources.some((x) => x.name === name) && (!core.only || core.only.includes(name));
  return exists ? errorPage(core, ctx, d, 403, "Not allowed", "You do not have access to these records. Ask an organization owner for a role that can read them.") : errorPage(core, ctx, d, 404, "Not found", `There is no "${name}" section here.`);
}

// ------------------------------------------------------------------------------- overview

export async function overview(core: Core, ctx: Context): Promise<Response> {
  const d = await pageData(core, ctx);
  const body = html`<h1>${core.shell.title}</h1>${
    d.resources.length ? "" : alert("There is nothing you can open here yet. Ask an organization owner for access.")
  }<div class="grid-cards">${d.resources.map((r) => html`<a href="${core.path}/r/${r.name}">${r.label}${r.description ? html`<span class="help">${r.description}</span>` : ""}</a>`)}${
    d.workflows ? html`<a href="${core.path}/workflows">Workflows</a>` : ""
  }</div>`;
  return page(core.shell, ctx, { title: core.shell.title, active: "home", body, ...d });
}

// ------------------------------------------------------------------------------- list

interface ListParams {
  view?: string;
  filter?: Record<string, unknown>;
  q?: string;
  sort?: string;
  cursor?: string;
  limit?: string;
}

const NOTICES: Record<string, (r: ResourceMeta, n: number) => string> = {
  delete: (r, n) => `Deleted ${n} ${plural(r, n)}.`,
  set: (r, n) => `Updated ${n} ${plural(r, n)}.`,
  created: (r) => `${r.singular} created.`,
  saved: () => "Saved.",
};

function notice(r: ResourceMeta, url: URL): HtmlString | string {
  const done = url.searchParams.get("done");
  if (!done) return "";
  const n = Math.max(0, Math.min(100000, Number(url.searchParams.get("count") ?? "1") || 0));
  if (Object.prototype.hasOwnProperty.call(NOTICES, done)) return alert(NOTICES[done](r, n), "ok");
  if (done.startsWith("action:")) {
    const a = r.actions.find((x) => x.name === done.slice(7));
    if (a) return alert(`${a.label}: done.`, "ok");
  }
  return "";
}

function readList(r: ResourceMeta, url: URL): { p: ListParams; errors: string[] } {
  const sp = url.searchParams;
  const p: ListParams = {};
  const errors: string[] = [];
  for (const k of ["view", "q", "sort", "cursor", "limit"] as const) {
    const v = sp.get(k);
    if (v) p[k] = v;
  }
  const ff = sp.getAll("ff");
  if (ff.length) {
    const fo = sp.getAll("fo");
    const fv = sp.getAll("fv");
    const out = filters.rowsToFilter(
      ff.map((field, i) => ({ field, op: fo[i] ?? "eq", value: fv[i] ?? "" })),
      r.fields,
    );
    errors.push(...out.errors.map((e) => e.message));
    if (Object.keys(out.filter).length) p.filter = out.filter;
  } else if (sp.get("filter")) {
    try {
      const f = JSON.parse(sp.get("filter")!);
      p.filter = f;
    } catch {
      p.filter = undefined;
      return { p: { ...p, filter: { __invalid: sp.get("filter") } as Record<string, unknown> }, errors };
    }
  }
  return { p, errors };
}

/** The API query string for a list request. */
function apiQuery(p: ListParams, extra: Record<string, string> = {}): string {
  const s = new URLSearchParams();
  if (p.view) s.set("view", p.view);
  if (p.filter) s.set("filter", (p.filter as { __invalid?: string }).__invalid ?? JSON.stringify(p.filter));
  if (p.q) s.set("q", p.q);
  if (p.sort) s.set("sort", p.sort);
  if (p.cursor) s.set("cursor", p.cursor);
  if (p.limit) s.set("limit", p.limit);
  for (const [k, v] of Object.entries(extra)) s.set(k, v);
  return s.toString();
}

const cleanFilter = (f: ListParams["filter"]) => (f && !(f as { __invalid?: string }).__invalid ? f : undefined);

function relationsToInclude(r: ResourceMeta, d: PageData): string[] {
  return r.fields.filter((f) => f.type === "relation" && d.schema.resources.some((x) => x.name === f.relation!.resource)).map((f) => f.name);
}

function cell(core: Core, d: PageData, f: FieldMeta, rec: Record<string, any>): HtmlString {
  if (f.type === "relation" && rec[f.name]) {
    const inc = rec._included?.[f.name];
    const target = d.resources.find((x) => x.name === f.relation!.resource);
    if (inc) return displayValue(f, rec[f.name], { title: String(inc[f.relation!.titleField] ?? inc.id), href: target ? `${core.path}/r/${target.name}/${inc.id}` : undefined });
  }
  return displayValue(f, rec[f.name]);
}

function columns(r: ResourceMeta, view: ResourceMeta["views"][number] | undefined): FieldMeta[] {
  const byName = (n: string) => r.fields.find((f) => f.name === n);
  if (view?.fields?.length) return [r.titleField, ...view.fields.filter((n) => n !== r.titleField)].map(byName).filter((f): f is FieldMeta => !!f);
  const title = byName(r.titleField);
  const rest = r.fields.filter((f) => !f.system && !f.hidden && f.name !== r.titleField && f.type !== "json").slice(0, 7);
  const updated = byName("updatedAt");
  return [title, ...rest, updated].filter((f): f is FieldMeta => !!f);
}

function filterForm(core: Core, r: ResourceMeta, p: ListParams): HtmlString {
  const fields = r.fields.filter((f) => f.operators.length && !(f.hidden && f.system));
  const meta = fields.map((f) => ({ name: f.name, type: f.type, label: f.label, operators: f.operators, options: f.options?.map((o) => ({ value: o.value, label: o.label })), currencyDigits: f.currencyDigits, integer: f.integer }));
  const rows = [...filters.filterToRows(cleanFilter(p.filter) ?? {}, fields), { field: "", op: "", value: "" }];
  const allOps = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "contains", "isNull"];
  const row = (x: { field: string; op: string; value: string }, i: number) =>
    html`<div class="filter-row"><select name="ff" aria-label="Field ${i + 1}"><option value="">Field…</option>${fields.map((f) => html`<option value="${f.name}"${f.name === x.field ? raw(" selected") : ""}>${f.label}</option>`)}</select><select name="fo" aria-label="Operator ${i + 1}">${allOps.map(
      (o) => html`<option value="${o}"${o === (x.op || "eq") ? raw(" selected") : ""}>${filters.operators({ name: "", type: "", label: "", operators: [o] })[0].label}</option>`,
    )}</select><input type="text" name="fv" aria-label="Value ${i + 1}" value="${x.value}"></div>`;
  const filterJson = cleanFilter(p.filter) ? JSON.stringify(p.filter) : "";
  return html`<form method="get" action="${core.path}/r/${r.name}" class="panel filters" data-filter-builder data-fields="${JSON.stringify(meta)}">${p.view ? html`<input type="hidden" name="view" value="${p.view}">` : ""}${
    p.sort ? html`<input type="hidden" name="sort" value="${p.sort}">` : ""
  }<div class="filter-row"><label for="list-q">Search</label><input type="search" id="list-q" name="q" value="${p.q ?? ""}"></div><fieldset class="field"><legend>Filters</legend><div class="field-error" data-filter-errors tabindex="-1" role="alert" hidden></div><div data-filter-rows>${rows.map(row)}</div><button type="button" data-filter-add hidden>Add filter</button></fieldset><input type="hidden" name="filter" value="${filterJson}"><div class="toolbar"><button type="submit" class="primary">Apply</button><a href="${core.path}/r/${r.name}${qs(
    filters.toQuery({ view: p.view }),
  )}">Clear</a></div></form>`;
}

function viewTabs(core: Core, r: ResourceMeta, p: ListParams): HtmlString | string {
  if (!r.views.length) return "";
  const tab = (href: string, label: string, current: boolean) => html`<a href="${href}"${current ? raw(' aria-current="page"') : ""}>${label}</a>`;
  return html`<nav class="tabs" aria-label="Views">${tab(`${core.path}/r/${r.name}`, "All", !p.view)}${r.views.map((v) => tab(`${core.path}/r/${r.name}?view=${encodeURIComponent(v.name)}`, v.label, p.view === v.name))}</nav>`;
}

function headActions(core: Core, r: ResourceMeta, p: ListParams): HtmlString {
  const exportQs = filters.toQuery({ view: p.view, filter: cleanFilter(p.filter), q: p.q, sort: p.sort });
  return html`<div class="toolbar">${r.can.create ? html`<a class="btn primary" href="${core.path}/r/${r.name}/new">New ${r.singular.toLowerCase()}</a>` : ""}${
    r.can.import && r.can.create ? html`<a class="btn" href="${core.path}/r/${r.name}/import">Import CSV</a>` : ""
  }${r.can.export ? html`<a class="btn" href="${core.path}/r/${r.name}/export.csv${qs(exportQs)}" download>Export CSV</a>` : ""}</div>`;
}

function setOptions(r: ResourceMeta): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  for (const f of writable(r.fields)) if (f.type === "select") for (const o of f.options ?? []) out.push({ value: `set:${f.name}:${o.value}`, label: `${f.label} → ${o.label}` });
  return out;
}

function bulkBar(r: ResourceMeta): HtmlString | string {
  const sets = r.can.update ? setOptions(r) : [];
  if (!r.can.delete && !r.actions.length && !sets.length) return "";
  return html`<div class="toolbar" role="group" aria-label="Bulk actions"><span data-selected-count aria-live="polite">Select rows to act on several at once.</span>${r.actions.map(
    (a) => html`<button type="submit" name="op" value="action:${a.name}" data-bulk${a.confirm ? html` data-confirm="${typeof a.confirm === "string" ? a.confirm : `${a.label}?`}"` : ""}>${a.label}</button>`,
  )}${
    sets.length
      ? html`<label for="bulk-set" class="sr-only">Set a field</label><select id="bulk-set" name="setop">${sets.map((s) => html`<option value="${s.value}">${s.label}</option>`)}</select><button type="submit" name="op" value="set" data-bulk>Apply</button>`
      : ""
  }${r.can.delete ? html`<button type="submit" name="op" value="delete" class="danger" data-bulk data-confirm="Delete the selected ${r.label.toLowerCase()}?">Delete</button>` : ""}</div>`;
}

function table(core: Core, d: PageData, r: ResourceMeta, p: ListParams, items: Record<string, any>[], url: URL): HtmlString {
  const view = p.view ? r.views.find((v) => v.name === p.view) : undefined;
  const cols = columns(r, view);
  const current = p.sort ?? view?.sort ?? r.defaultSort;
  const bulk = bulkBar(r);
  const selectable = bulk !== "";
  const th = (f: FieldMeta) => {
    if (!f.sortable) return html`<th scope="col">${f.label}</th>`;
    const state = current === f.name ? "ascending" : current === `-${f.name}` ? "descending" : "none";
    const next = state === "ascending" ? `-${f.name}` : f.name;
    return html`<th scope="col" aria-sort="${state}"><a href="${core.path}/r/${r.name}${qs(filters.toQuery({ view: p.view, filter: cleanFilter(p.filter), q: p.q, sort: next }))}">${f.label}</a></th>`;
  };
  const rows = items.map(
    (rec) =>
      html`<tr>${selectable ? html`<td><input type="checkbox" name="ids" value="${rec.id}" aria-label="Select ${titleOf(r, rec)}"></td>` : ""}${cols.map((f, i) =>
        i === 0 ? html`<td><a href="${core.path}/r/${r.name}/${rec.id}">${titleOf(r, rec)}</a></td>` : html`<td${f.type === "richText" ? raw(' class="rt"') : ""}>${cell(core, d, f, rec)}</td>`,
      )}</tr>`,
  );
  const tableHtml = html`<div class="table-wrap"><table><caption class="sr-only">${r.label}</caption><thead><tr>${selectable ? html`<th scope="col"><input type="checkbox" data-select-all aria-label="Select all rows"></th>` : ""}${cols.map(th)}</tr></thead><tbody>${
    rows.length ? rows : html`<tr><td colspan="${cols.length + (selectable ? 1 : 0)}" class="muted">No ${r.label.toLowerCase()} match.</td></tr>`
  }</tbody></table></div>`;
  if (!selectable) return tableHtml;
  return html`<form method="post" action="${core.path}/r/${r.name}/bulk">${bulk}<input type="hidden" name="back" value="${url.pathname + url.search}">${tableHtml}</form>`;
}

function kanban(core: Core, r: ResourceMeta, view: ResourceMeta["views"][number], items: Record<string, any>[], url: URL): HtmlString {
  const f = r.fields.find((x) => x.name === view.groupBy)!;
  const cols = [...(f.options ?? []).map((o) => ({ key: o.value, label: o.label })), { key: "", label: `No ${f.label.toLowerCase()}` }];
  const known = new Set(cols.map((c) => c.key));
  const groups = new Map<string, Record<string, any>[]>(cols.map((c) => [c.key, []]));
  for (const rec of items) groups.get(typeof rec[f.name] === "string" && known.has(rec[f.name]) ? rec[f.name] : "")!.push(rec);
  const back = url.pathname + url.search;
  const PRIORITY = ["money", "date", "datetime", "number", "percent", "select", "user", "relation"];
  const candidates = r.fields
    .filter((x) => !x.system && !x.hidden && x.name !== r.titleField && x.name !== f.name && PRIORITY.includes(x.type))
    .sort((a, b) => PRIORITY.indexOf(a.type) - PRIORITY.indexOf(b.type));
  const card = (rec: Record<string, any>) => {
    const title = titleOf(r, rec);
    const meta = candidates.filter((m) => rec[m.name] !== null && rec[m.name] !== undefined && rec[m.name] !== "").slice(0, 2);
    const move = r.can.update
      ? html`<form method="post" action="${core.path}/r/${r.name}/bulk" class="move"><input type="hidden" name="ids" value="${rec.id}"><input type="hidden" name="back" value="${back}"><input type="hidden" name="op" value="set"><label class="sr-only" for="mv-${rec.id}">Move ${title} to</label><select id="mv-${rec.id}" name="setop">${cols.map(
          (c) => html`<option value="set:${f.name}:${c.key}"${(rec[f.name] ?? "") === c.key ? raw(" selected") : ""}>${c.label}</option>`,
        )}</select><button type="submit">Move</button></form>`
      : "";
    return html`<li class="card" tabindex="0" draggable="${r.can.update ? "true" : "false"}" data-id="${rec.id}" data-title="${title}" aria-describedby="board-help"><a href="${core.path}/r/${r.name}/${rec.id}">${title}</a>${meta.map(
      (m) => (html`<div class="meta">${m.label}: ${displayValue(m, rec[m.name])}</div>`),
    )}${move}</li>`;
  };
  return html`<p id="board-help" class="help">Use the arrow keys on a focused card: ← and → move it to the previous or next column, ↑ and ↓ go to the next card. You can also drag cards, or use each card's Move menu.</p><div class="board" data-board data-field="${f.name}" data-path="${r.path}">${cols.map(
    (c, i) =>
      html`<section class="column" aria-labelledby="col-h-${i}"><h2 id="col-h-${i}">${c.key ? badge(f, c.key) : c.label} <span class="count" data-count="${c.key}">${groups.get(c.key)!.length}</span></h2><ol data-col="${c.key}" data-label="${c.label}" aria-labelledby="col-h-${i}">${groups
        .get(c.key)!
        .map(card)}</ol></section>`,
  )}</div>`;
}

function calendar(core: Core, r: ResourceMeta, view: ResourceMeta["views"][number], items: Record<string, any>[], p: ListParams, month: { year: number; month: number }): HtmlString {
  const f = r.fields.find((x) => x.name === view.dateField)!;
  const range = monthRange(month.year, month.month);
  const byDay = new Map<string, Record<string, any>[]>();
  for (const rec of items) {
    const v = rec[f.name];
    if (typeof v !== "string") continue;
    const day = v.slice(0, 10);
    (byDay.get(day) ?? byDay.set(day, []).get(day)!).push(rec);
  }
  const base = filters.toQuery({ view: p.view, filter: cleanFilter(p.filter), q: p.q });
  const nav = (m: string) => `${core.path}/r/${r.name}?${base}${base ? "&" : ""}month=${m}`;
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return html`<div class="toolbar"><a class="btn" href="${nav(range.prev)}" rel="prev">← Previous month</a><a class="btn" href="${nav(range.next)}" rel="next">Next month →</a></div><div class="table-wrap"><table class="calendar"><caption>${range.label}</caption><thead><tr>${days.map(
    (d) => html`<th scope="col">${d}</th>`,
  )}</tr></thead><tbody>${monthGrid(month.year, month.month).map(
    (week) =>
      html`<tr>${week.map((day) => {
        const recs = byDay.get(day.date) ?? [];
        return html`<td data-date="${day.date}"${day.inMonth ? "" : raw(' class="out"')}><span class="day"><span class="sr-only">${day.date}</span><span aria-hidden="true">${Number(day.date.slice(8))}</span></span>${
          recs.length ? html`<ul>${recs.map((rec) => html`<li><a href="${core.path}/r/${r.name}/${rec.id}">${titleOf(r, rec)}</a></li>`)}</ul>` : ""
        }</td>`;
      })}</tr>`,
  )}</tbody></table></div>`;
}

export async function listPage(core: Core, ctx: Context, name: string): Promise<Response> {
  const found = await resourcePage(core, ctx, name);
  if (found instanceof Response) return found;
  const { d, r } = found;
  const url = ctx.url;
  const { p, errors } = readList(r, url);
  const view = p.view ? r.views.find((v) => v.name === p.view) : undefined;
  const kind = view?.kind ?? "table";
  const include = relationsToInclude(r, d);
  let query: string;
  let month: { year: number; month: number } | null = null;
  if (kind === "calendar") {
    month = parseMonth(url.searchParams.get("month"), new Date());
    const range = monthRange(month.year, month.month);
    const df = r.fields.find((f) => f.name === view!.dateField)!;
    const cond = df.type === "datetime" ? { gte: `${range.first}T00:00:00.000Z`, lt: `${range.next}-01T00:00:00.000Z` } : { gte: range.first, lte: range.last };
    query = apiQuery({ ...p, cursor: undefined, limit: "200", filter: { ...(cleanFilter(p.filter) ?? {}), [df.name]: cond } });
  } else if (kind === "kanban") query = apiQuery({ ...p, cursor: undefined, limit: "200" });
  else query = apiQuery(p, include.length ? { include: include.join(",") } : {});
  const res = await sub(core.app, ctx, "GET", `${r.path}${qs(query)}`);
  const items: Record<string, any>[] = res.ok ? res.data.items : [];
  let content: HtmlString;
  if (!res.ok) content = html``;
  else if (kind === "kanban" && view) content = kanban(core, r, view, items, url);
  else if (kind === "calendar" && view) content = calendar(core, r, view, items, p, month!);
  else {
    const pager: HtmlString[] = [];
    if (p.cursor) pager.push(html`<a class="btn" href="${core.path}/r/${r.name}${qs(filters.toQuery({ view: p.view, filter: cleanFilter(p.filter), q: p.q, sort: p.sort }) + (p.limit ? `&limit=${encodeURIComponent(p.limit)}` : ""))}">First page</a>`);
    if (res.data.nextCursor) {
      const s = new URLSearchParams(filters.toQuery({ view: p.view, filter: cleanFilter(p.filter), q: p.q, sort: p.sort }));
      if (p.limit) s.set("limit", p.limit);
      s.set("cursor", res.data.nextCursor);
      pager.push(html`<a class="btn" href="${core.path}/r/${r.name}?${s.toString()}" rel="next">Next page</a>`);
    }
    content = html`${table(core, d, r, p, items, url)}${pager.length ? html`<nav class="pager" aria-label="Pages">${pager}</nav>` : ""}`;
  }
  const body = html`<div class="page-head"><h1>${r.label}</h1>${headActions(core, r, p)}</div>${notice(r, url)}${errors.length ? alert(errors) : ""}${res.ok ? "" : alert(apiMessage(res.data))}${viewTabs(core, r, p)}${
    kind === "table" || kind === "kanban" ? filterForm(core, r, p) : ""
  }${content}`;
  return page(core.shell, ctx, { title: r.label, active: r.name, body, status: res.ok ? 200 : res.status, ...d });
}

export async function exportCsv(core: Core, ctx: Context, name: string): Promise<Response> {
  const found = await resourcePage(core, ctx, name);
  if (found instanceof Response) return found;
  const { p } = readList(found.r, ctx.url);
  const headers = new Headers();
  ctx.req.headers.forEach((v, k) => headers.set(k, v));
  const org = orgOf(ctx);
  if (org) headers.set("x-org-id", org);
  const req = new Request(new URL(`${found.r.endpoints.export.path}${qs(apiQuery({ ...p, cursor: undefined, limit: undefined }))}`, ctx.url.origin), { headers });
  return core.app.dispatch(req, ctx.env, (ctx as any)._platform);
}

// ------------------------------------------------------------------------------- record

function defaults(r: ResourceMeta, ctx: Context): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const now = new Date().toISOString();
  for (const f of writable(r.fields)) {
    if (f.default === undefined) continue;
    out[f.name] = f.default === "currentUser" && f.type === "user" ? (ctx.user?.id ?? null) : f.default === "today" && f.type === "date" ? now.slice(0, 10) : f.default === "now" && f.type === "datetime" ? now : f.default;
  }
  return out;
}

async function members(core: Core, ctx: Context, r: ResourceMeta): Promise<{ id: string; label: string }[] | undefined> {
  if (!r.fields.some((f) => f.type === "user" && !f.system && !f.readOnly)) return undefined;
  const org = orgOf(ctx);
  if (!org) return undefined;
  const res = await sub(core.app, ctx, "GET", `${core.orgsPath}/${encodeURIComponent(org)}/members`);
  if (!res.ok || !Array.isArray(res.data?.members)) return undefined;
  return res.data.members.map((m: { userId: string; email: string | null }) => ({ id: m.userId, label: m.email ?? m.userId }));
}

function actionForm(core: Core, r: ResourceMeta, a: ActionMeta, id: string): HtmlString {
  const fields = a.input ? schemaForm.fields(a.input) : [];
  return html`<form method="post" action="${core.path}/r/${r.name}/${id}/action/${a.name}" class="toolbar">${fields.map((f) => {
    const fid = `act-${a.name}-${f.name || "value"}`;
    const name = `in.${f.name}`;
    const control =
      f.kind === "enum"
        ? html`<select id="${fid}" name="${name}">${(f.options ?? []).map((o) => html`<option value="${o}">${o}</option>`)}</select>`
        : f.kind === "boolean"
          ? html`<input type="checkbox" id="${fid}" name="${name}" value="true">`
          : f.kind === "json"
            ? html`<textarea id="${fid}" name="${name}" rows="2" class="mono"></textarea>`
            : html`<input type="${f.kind === "text" ? "text" : "number"}" id="${fid}" name="${name}"${f.required ? raw(" required") : ""}>`;
    return html`<label for="${fid}">${f.name || "Input"}</label>${control}`;
  })}<button type="submit"${a.confirm ? html` data-confirm="${typeof a.confirm === "string" ? a.confirm : `${a.label}?`}"` : ""}>${a.label}</button></form>`;
}

async function timelinePanel(core: Core, ctx: Context, r: ResourceMeta, id: string, d: PageData): Promise<HtmlString | string> {
  if (!core.timelinePath) return "";
  const res = await sub(core.app, ctx, "GET", `${core.timelinePath}/${encodeURIComponent(r.name)}/${encodeURIComponent(id)}?limit=50`);
  if (!res.ok || !Array.isArray(res.data?.items)) return "";
  const acts = d.resources.find((x) => x.name === "activities");
  const entry = (e: any) => {
    const when = typeof e.at === "string" ? `${e.at.slice(0, 10)} ${e.at.slice(11, 16)} UTC` : "";
    if (e.kind === "activity") {
      const a = e.activity ?? {};
      return html`<li><div class="when">${when} · ${String(a.type ?? "activity")}${e.actor ? ` · ${e.actor}` : ""}</div><strong>${acts ? html`<a href="${core.path}/r/activities/${e.id}">${e.title}</a>` : e.title}</strong>${
        a.body ? html`<div class="rt">${richText(a.body)}</div>` : ""
      }</li>`;
    }
    const changes = e.changes && typeof e.changes === "object" ? Object.entries(e.changes as Record<string, any>) : [];
    return html`<li><div class="when">${when}${e.actor ? ` · ${e.actor}` : ""}</div><strong>${e.title}</strong>${
      changes.length
        ? html`<ul>${changes.slice(0, 10).map(([k, v]) => html`<li>${k}: ${v && typeof v === "object" && "before" in v ? JSON.stringify(v.before) : ""} → ${v && typeof v === "object" && "after" in v ? JSON.stringify(v.after) : ""}</li>`)}</ul>`
        : ""
    }</li>`;
  };
  return html`<section class="panel" aria-labelledby="timeline-h"><h2 id="timeline-h">Timeline</h2>${
    res.data.items.length ? html`<ol class="timeline">${res.data.items.map(entry)}</ol>` : html`<p class="muted">Nothing yet.</p>`
  }${acts?.can.create ? html`<p><a href="${core.path}/r/activities/new?subjectType=${encodeURIComponent(r.name)}&amp;subjectId=${encodeURIComponent(id)}">Log an activity</a></p>` : ""}</section>`;
}

interface FormState {
  values: Record<string, unknown>;
  errors: Record<string, string[]>;
  general: string[];
  status?: number;
}

async function recordView(core: Core, ctx: Context, d: PageData, r: ResourceMeta, rec: Record<string, any> | null, state: FormState): Promise<Response> {
  const isNew = rec === null;
  const editable = isNew ? r.can.create : r.can.update;
  const filesClient = (ctx as { files?: { signedUrl(k: string): Promise<string> } }).files;
  const hasFiles = !!filesClient && typeof filesClient.signedUrl === "function";
  const team = await members(core, ctx, r);
  const id = rec?.id as string | undefined;
  const fields = writable(r.fields);
  const controls: HtmlString[] = [];
  for (const f of fields) {
    let relationTitle: string | undefined;
    let relationHref: string | undefined;
    const v = state.values[f.name];
    if (f.type === "relation" && v) {
      const inc = rec?._included?.[f.name];
      if (inc && inc.id === v) {
        relationTitle = String(inc[f.relation!.titleField] ?? inc.id);
        if (d.resources.some((x) => x.name === f.relation!.resource)) relationHref = `${core.path}/r/${f.relation!.resource}/${inc.id}`;
      }
    }
    let fileUrl: string | undefined;
    if (f.type === "file" && typeof v === "string" && v && hasFiles) {
      try {
        fileUrl = await filesClient!.signedUrl(v);
      } catch {}
    }
    controls.push(renderField(f, v, { errors: state.errors[f.name], relationTitle, relationHref, members: team, files: hasFiles, fileUrl }));
  }
  const multipart = hasFiles && fields.some((f) => f.type === "file");
  const action = isNew ? `${core.path}/r/${r.name}/new` : `${core.path}/r/${r.name}/${id}`;
  const title = isNew ? `New ${r.singular.toLowerCase()}` : titleOf(r, rec!);
  const form = html`<form method="post" action="${action}" class="panel"${multipart ? raw(' enctype="multipart/form-data"') : ""}><fieldset${editable ? "" : raw(" disabled")}>${controls}</fieldset>${
    editable ? html`<button type="submit" class="primary">${isNew ? "Create" : "Save"}</button>` : html`<p class="muted">You can view this ${r.singular.toLowerCase()} but not change it.</p>`
  }</form>`;
  const actions =
    !isNew && (r.actions.length || r.can.delete)
      ? html`<section class="panel" aria-labelledby="actions-h"><h2 id="actions-h">Actions</h2>${r.actions.map((a) => actionForm(core, r, a, id!))}${
          r.can.delete
            ? html`<form method="post" action="${core.path}/r/${r.name}/${id}/delete"><button type="submit" class="danger" data-confirm="Delete this ${r.singular.toLowerCase()}?">Delete ${r.singular.toLowerCase()}</button></form>`
            : ""
        }</section>`
      : "";
  const sys = r.fields.filter((f) => f.system || f.readOnly);
  const details =
    !isNew && rec
      ? html`<section class="panel" aria-labelledby="details-h"><h2 id="details-h">Details</h2><dl class="meta">${sys.map((f) => html`<dt>${f.label}</dt><dd>${f.type === "richText" ? richText(rec[f.name]) : displayValue(f, rec[f.name])}</dd>`)}</dl></section>`
      : "";
  const timeline = !isNew && id ? await timelinePanel(core, ctx, r, id, d) : "";
  const errorCount = Object.keys(state.errors).length;
  const errorSummary =
    state.general.length || errorCount
      ? html`<div class="alert" role="alert" tabindex="-1"><p>${errorCount ? `Please fix ${errorCount} field${errorCount === 1 ? "" : "s"}:` : "This could not be saved:"}</p><ul>${Object.entries(state.errors).map(([k, msgs]) => {
          const f = r.fields.find((x) => x.name === k);
          return html`<li><a href="#f-${k}">${f?.label ?? k}</a>: ${msgs.join("; ")}</li>`;
        })}${state.general.map((m) => html`<li>${m}</li>`)}</ul></div>`
      : "";
  const body = html`<div class="page-head"><h1>${title}</h1><div class="toolbar"><a href="${core.path}/r/${r.name}">All ${r.label.toLowerCase()}</a></div></div>${notice(r, ctx.url)}${errorSummary}<div class="record"><div>${form}${actions}</div><aside>${details}${timeline}</aside></div>`;
  return page(core.shell, ctx, { title, active: r.name, body, status: state.status, ...d });
}

async function fetchRecord(core: Core, ctx: Context, d: PageData, r: ResourceMeta, id: string) {
  const include = relationsToInclude(r, d);
  return sub(core.app, ctx, "GET", `${r.path}/${encodeURIComponent(id)}${include.length ? `?include=${include.join(",")}` : ""}`);
}

export async function recordPage(core: Core, ctx: Context, name: string, id: string): Promise<Response> {
  const found = await resourcePage(core, ctx, name);
  if (found instanceof Response) return found;
  const { d, r } = found;
  const res = await fetchRecord(core, ctx, d, r, id);
  if (!res.ok) return errorPage(core, ctx, d, res.status, res.status === 404 ? "Not found" : "Could not load", apiMessage(res.data), r.name);
  return recordView(core, ctx, d, r, res.data, { values: res.data, errors: {}, general: [] });
}

export async function newPage(core: Core, ctx: Context, name: string): Promise<Response> {
  const found = await resourcePage(core, ctx, name);
  if (found instanceof Response) return found;
  const { d, r } = found;
  if (!r.can.create) return errorPage(core, ctx, d, 403, "Not allowed", `You cannot create ${r.label.toLowerCase()}.`, r.name);
  const values = defaults(r, ctx);
  // Prefill from the query (e.g. "Log an activity" links), only for writable fields.
  for (const f of writable(r.fields)) {
    const v = ctx.url.searchParams.get(f.name);
    if (v !== null && ["text", "select", "relation", "user", "date", "email"].includes(f.type)) values[f.name] = v;
  }
  return recordView(core, ctx, d, r, null, { values, errors: {}, general: [] });
}

/** Uploads file inputs with @miujs/files and replaces them with their keys. */
async function uploadFiles(core: Core, ctx: Context, r: ResourceMeta, form: FormValues): Promise<Record<string, string>> {
  const errors: Record<string, string> = {};
  const files = (ctx as { files?: { put(k: string, b: Blob, o?: { contentType?: string }): Promise<unknown> } }).files;
  for (const f of r.fields.filter((x) => x.type === "file" && !x.readOnly && !x.system)) {
    const v = form[f.name];
    if (!(v instanceof Blob)) continue;
    delete form[f.name];
    if (v.size === 0) continue;
    if (!files) {
      errors[f.name] = "File uploads need @miujs/files";
      continue;
    }
    if (v.size > core.maxUpload) {
      errors[f.name] = `is larger than ${Math.round(core.maxUpload / 1048576)} MB`;
      continue;
    }
    const original = ((v as File).name ?? "").split(/[\\/]/).pop() ?? "";
    const base = original.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "").slice(-100) || "file";
    const key = `admin/${r.name}/${crypto.randomUUID()}/${base}`;
    await files.put(key, v, { contentType: v.type || "application/octet-stream" });
    form[f.name] = key;
  }
  return errors;
}

export async function saveRecord(core: Core, ctx: Context, name: string, id: string | null): Promise<Response> {
  const found = await resourcePage(core, ctx, name);
  if (found instanceof Response) return found;
  const { d, r } = found;
  const form = { ...((ctx.body as FormValues) ?? {}) };
  let current: Record<string, any> | null = null;
  if (id !== null) {
    const got = await fetchRecord(core, ctx, d, r, id);
    if (!got.ok) return errorPage(core, ctx, d, got.status, got.status === 404 ? "Not found" : "Could not save", apiMessage(got.data), r.name);
    current = got.data;
  } else if (!r.can.create) return errorPage(core, ctx, d, 403, "Not allowed", `You cannot create ${r.label.toLowerCase()}.`, r.name);
  if (id !== null && !r.can.update) return errorPage(core, ctx, d, 403, "Not allowed", `You cannot change ${r.label.toLowerCase()}.`, r.name);
  const uploadErrors = await uploadFiles(core, ctx, r, form);
  const { body, errors } = formToBody(r.fields, form, id === null ? "create" : "update");
  Object.assign(errors, uploadErrors);
  const rawValues: Record<string, unknown> = {};
  for (const f of writable(r.fields)) if (!(f.name in body) && typeof form[f.name] === "string") rawValues[f.name] = form[f.name];
  const values = { ...(current ?? defaults(r, ctx)), ...body, ...rawValues };
  const fieldErr = Object.fromEntries(Object.entries(errors).map(([k, v]) => [k, [v]]));
  if (Object.keys(errors).length) return recordView(core, ctx, d, r, current, { values, errors: fieldErr, general: [], status: 400 });
  const res =
    id === null
      ? await sub(core.app, ctx, "POST", r.path, { body })
      : await (async () => {
          const changes = changedOnly(current!, body);
          if (!Object.keys(changes).length) return { ok: true, status: 200, data: current, headers: new Headers() };
          return sub(core.app, ctx, "PATCH", `${r.path}/${encodeURIComponent(id)}`, { body: changes });
        })();
  if (!res.ok) {
    const fe = fieldErrors(res.data, r.fields);
    return recordView(core, ctx, d, r, current, { values, errors: fe.fields, general: fe.general, status: res.status });
  }
  const newId = id ?? (res.data.id as string);
  return redirect(`${core.path}/r/${r.name}/${encodeURIComponent(newId)}?done=${id === null ? "created" : "saved"}`);
}

// ------------------------------------------------------------------------------- confirm, delete, actions, bulk

function confirmPage(core: Core, ctx: Context, d: PageData, r: ResourceMeta, question: string, fields: Record<string, string | string[]>, back: string): Response {
  const hidden = Object.entries(fields).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((x) => html`<input type="hidden" name="${k}" value="${x}">`));
  const body = html`<h1>${question}</h1><form method="post" action="${ctx.url.pathname}" class="panel">${hidden}<input type="hidden" name="confirmed" value="1"><div class="toolbar"><button type="submit" class="danger">Yes, continue</button><a class="btn" href="${back}">Cancel</a></div></form>`;
  return page(core.shell, ctx, { title: question, active: r.name, body, ...d });
}

const formStrings = (form: FormValues, prefix: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(form)) if (k.startsWith(prefix) && typeof v === "string") out[k.slice(prefix.length)] = v;
  return out;
};

export async function deleteRecord(core: Core, ctx: Context, name: string, id: string): Promise<Response> {
  const found = await resourcePage(core, ctx, name);
  if (found instanceof Response) return found;
  const { d, r } = found;
  const form = (ctx.body as FormValues) ?? {};
  if (form.confirmed !== "1") return confirmPage(core, ctx, d, r, `Delete this ${r.singular.toLowerCase()}?`, {}, `${core.path}/r/${r.name}/${encodeURIComponent(id)}`);
  const res = await sub(core.app, ctx, "DELETE", `${r.path}/${encodeURIComponent(id)}`);
  if (!res.ok) return errorPage(core, ctx, d, res.status, "Could not delete", apiMessage(res.data), r.name);
  return redirect(`${core.path}/r/${r.name}?done=delete&count=1`);
}

async function runAction(core: Core, ctx: Context, d: PageData, r: ResourceMeta, a: ActionMeta, ids: string[], form: FormValues): Promise<{ ok: true } | Response> {
  let input: unknown;
  if (a.input) {
    const fields = schemaForm.fields(a.input);
    const out = schemaForm.coerce(fields, formStrings(form, "in."));
    if (out.errors.length) return errorPage(core, ctx, d, 400, a.label, out.errors.map((e) => `${e.name || "Input"} ${e.message}`), r.name);
    input = fields.length === 1 && fields[0].name === "" ? out.value[""] : out.value;
  }
  const res = await sub(core.app, ctx, "POST", `${r.path}/actions/${encodeURIComponent(a.name)}`, { body: { ids, ...(input === undefined ? {} : { input }) } });
  if (!res.ok) return errorPage(core, ctx, d, res.status, a.label, apiMessage(res.data), r.name);
  return { ok: true };
}

export async function recordAction(core: Core, ctx: Context, name: string, id: string, actionName: string): Promise<Response> {
  const found = await resourcePage(core, ctx, name);
  if (found instanceof Response) return found;
  const { d, r } = found;
  const a = r.actions.find((x) => x.name === actionName);
  if (!a) return errorPage(core, ctx, d, 404, "Not found", `There is no action "${actionName}" you can run here.`, r.name);
  const form = (ctx.body as FormValues) ?? {};
  if (a.confirm && form.confirmed !== "1") {
    const keep: Record<string, string> = {};
    for (const [k, v] of Object.entries(form)) if (k.startsWith("in.") && typeof v === "string") keep[k] = v;
    return confirmPage(core, ctx, d, r, typeof a.confirm === "string" ? a.confirm : `${a.label}?`, keep, `${core.path}/r/${r.name}/${encodeURIComponent(id)}`);
  }
  const out = await runAction(core, ctx, d, r, a, [id], form);
  if (out instanceof Response) return out;
  return redirect(`${core.path}/r/${r.name}/${encodeURIComponent(id)}?done=action:${encodeURIComponent(a.name)}`);
}

export async function bulk(core: Core, ctx: Context, name: string): Promise<Response> {
  const found = await resourcePage(core, ctx, name);
  if (found instanceof Response) return found;
  const { d, r } = found;
  const form = (ctx.body as FormValues) ?? {};
  const ids = [...new Set(asList(form.ids))];
  const list = `${core.path}/r/${r.name}`;
  const back = typeof form.back === "string" ? safeNext(form.back, list) : null;
  let op = typeof form.op === "string" ? form.op : Array.isArray(form.op) ? String(form.op[form.op.length - 1]) : "";
  if (op === "set" && typeof form.setop === "string") op = form.setop;
  if (!ids.length) return errorPage(core, ctx, d, 400, "Nothing selected", `Select at least one ${r.singular.toLowerCase()} first.`, r.name);
  const keep = { ids, op, ...(back ? { back } : {}) };
  const done = (what: string) => redirect(back ?? `${list}?done=${encodeURIComponent(what)}&count=${ids.length}`);
  if (op === "delete") {
    if (form.confirmed !== "1") return confirmPage(core, ctx, d, r, `Delete ${ids.length} ${plural(r, ids.length)}?`, keep, back ?? list);
    const res = await sub(core.app, ctx, "POST", `${r.path}/bulk`, { body: { action: "delete", ids } });
    if (!res.ok) return errorPage(core, ctx, d, res.status, "Could not delete", apiMessage(res.data), r.name);
    return done("delete");
  }
  if (op.startsWith("action:")) {
    const a = r.actions.find((x) => x.name === op.slice(7));
    if (!a) return errorPage(core, ctx, d, 404, "Not found", "That action is not available.", r.name);
    if (a.confirm && form.confirmed !== "1") return confirmPage(core, ctx, d, r, typeof a.confirm === "string" ? a.confirm : `${a.label}: ${ids.length} ${plural(r, ids.length)}?`, keep, back ?? list);
    const out = await runAction(core, ctx, d, r, a, ids, form);
    if (out instanceof Response) return out;
    return done(op);
  }
  const m = /^set:([^:]+):(.*)$/.exec(op);
  if (m) {
    const f = writable(r.fields).find((x) => x.name === m[1] && x.type === "select");
    if (!f) return errorPage(core, ctx, d, 400, "Cannot set that field", `${m[1]} is not a field you can set here.`, r.name);
    const res = await sub(core.app, ctx, "POST", `${r.path}/bulk`, { body: { action: "update", ids, changes: { [f.name]: m[2] === "" ? null : m[2] } } });
    if (!res.ok) return errorPage(core, ctx, d, res.status, "Could not update", apiMessage(res.data), r.name);
    return done("set");
  }
  return errorPage(core, ctx, d, 400, "Unknown action", "Choose an action from the list.", r.name);
}

// ------------------------------------------------------------------------------- import

export async function importPage(core: Core, ctx: Context, name: string): Promise<Response> {
  const found = await resourcePage(core, ctx, name);
  if (found instanceof Response) return found;
  const { d, r } = found;
  if (!r.can.import || !r.can.create) return errorPage(core, ctx, d, 403, "Not allowed", `You cannot import ${r.label.toLowerCase()}.`, r.name);
  const fields = r.fields.map((f) => ({ name: f.name, label: f.label, readOnly: f.readOnly, system: f.system }));
  const targets = writable(r.fields);
  const body = html`<div class="page-head"><h1>Import ${r.label.toLowerCase()}</h1><div class="toolbar"><a href="${core.path}/r/${r.name}">All ${r.label.toLowerCase()}</a></div></div>
<div class="panel" data-import data-url="${r.endpoints.import.path}" data-list-url="${core.path}/r/${r.name}" data-fields="${JSON.stringify(fields)}">
<section><h2>1. Choose a CSV file</h2><div class="field"><label for="import-file">CSV file with a header row</label><input type="file" id="import-file" accept=".csv,text/csv" aria-describedby="import-help"><p class="help" id="import-help">Columns are matched to fields by name or label: ${targets.map((f, i) => html`${i ? ", " : ""}${f.label}`)}. Money is in major units (12.50). Nothing is written until you confirm after the dry run.</p></div></section>
<section data-step="map" hidden></section>
<section data-step="report" hidden aria-live="polite"></section>
<noscript><p class="alert">The import wizard needs JavaScript. You can also send the CSV to ${r.endpoints.import.path} with dryRun: true.</p></noscript>
</div>`;
  return page(core.shell, ctx, { title: `Import ${r.label.toLowerCase()}`, active: r.name, body, ...d });
}
