// Record forms: one control per field type, form posts → API bodies, API errors → field
// messages, and display formatting for lists. Everything is escaped by `html```; rich text is
// only ever inserted after the engine's sanitizer.

import { html, raw, type HtmlString } from "@miujs/web";
import type { FieldMeta } from "../meta.ts";
import { sanitizeHtml } from "../sanitize.ts";

export type FormValues = Record<string, unknown>;

/** Colors an option may ask for; anything else gets the neutral badge. */
export const BADGE_COLORS = ["gray", "red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"];

const TEXTS = new Set(["text", "email", "phone", "url"]);

const one = (v: unknown): unknown => (Array.isArray(v) ? v[v.length - 1] : v);
const str = (v: unknown): string | undefined => {
  const x = one(v);
  return typeof x === "string" ? x : undefined;
};
const list = (v: unknown): string[] => (v === undefined || v === null ? [] : (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === "string"));
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

export const fieldId = (name: string) => `f-${name}`;

/** Writable fields (what a form may send). */
export function writable(fields: FieldMeta[]): FieldMeta[] {
  return fields.filter((f) => !f.system && !f.readOnly);
}

function moneyIn(raw: string, digits: number): number | string {
  const clean = raw.replace(/[,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(clean)) return "must be an amount like 12.50";
  const [whole, frac = ""] = clean.replace("-", "").split(".");
  if (frac.length > digits) return `has more than ${digits} decimal places`;
  const minor = Number(whole) * 10 ** digits + Number(frac.padEnd(digits, "0") || "0");
  return clean.startsWith("-") ? -minor : minor;
}

export function moneyOut(v: unknown, digits: number): string {
  return typeof v === "number" ? (v / 10 ** digits).toFixed(digits) : "";
}

export function datetimeLocal(v: unknown): string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) ? v.slice(0, 16) : "";
}

/**
 * A submitted form → the JSON body for create/update. Read-only and system fields are ignored.
 * On update, empty inputs clear the field (null); on create they are left out.
 */
export function formToBody(fields: FieldMeta[], form: FormValues, mode: "create" | "update"): { body: Record<string, unknown>; errors: Record<string, string> } {
  const body: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  const bools = list(form._bool);
  const multis = list(form._multi);
  for (const f of writable(fields)) {
    const n = f.name;
    if (f.type === "boolean") {
      if (bools.includes(n) || own(form, n)) body[n] = str(form[n]) === "true" || str(form[n]) === "on";
      continue;
    }
    if (f.type === "multiSelect") {
      if (multis.includes(n) || own(form, n)) body[n] = [...new Set(list(form[n]))];
      continue;
    }
    if (f.type === "file") {
      if (str(form[`${n}__clear`]) === "true") body[n] = null;
      else {
        const v = str(form[n]);
        if (v) body[n] = v;
      }
      continue;
    }
    if (!own(form, n)) continue;
    const rawVal = str(form[n]);
    if (rawVal === undefined) continue;
    const v = TEXTS.has(f.type) ? rawVal.trim() : rawVal;
    if (v.trim() === "") {
      if (mode === "update") body[n] = f.type === "tags" ? [] : null;
      continue;
    }
    switch (f.type) {
      case "number":
      case "percent": {
        const x = Number(v.trim());
        if (!Number.isFinite(x)) errors[n] = "must be a number";
        else if (f.integer && !Number.isInteger(x)) errors[n] = "must be a whole number";
        else body[n] = x;
        break;
      }
      case "money": {
        const x = moneyIn(v.trim(), f.currencyDigits ?? 2);
        if (typeof x === "string") errors[n] = x;
        else body[n] = x;
        break;
      }
      case "datetime": {
        const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(:\d{2})?$/.exec(v.trim());
        const d = m ? new Date(`${m[1]}${m[2] ?? ":00"}Z`) : new Date(v.trim());
        if (Number.isNaN(d.getTime())) errors[n] = "must be a date and time";
        else body[n] = d.toISOString();
        break;
      }
      case "tags":
        body[n] = [...new Set(v.split(",").map((x) => x.trim()).filter(Boolean))];
        break;
      case "json":
        try {
          body[n] = JSON.parse(v);
        } catch {
          errors[n] = "is not valid JSON";
        }
        break;
      default:
        body[n] = v;
    }
  }
  return { body, errors };
}

/** Only the keys of `next` whose values differ from `current`. */
export function changedOnly(current: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(next)) {
    const before = current[k] === undefined ? null : current[k];
    if (JSON.stringify(before) !== JSON.stringify(v)) out[k] = v;
  }
  return out;
}

/** An API error body → messages per field (validation issues, details.field) and the rest. */
export function fieldErrors(res: unknown, fields: FieldMeta[]): { fields: Record<string, string[]>; general: string[] } {
  const out: { fields: Record<string, string[]>; general: string[] } = { fields: {}, general: [] };
  const err = (res as { error?: { message?: string; fix?: string; details?: any } } | null)?.error;
  if (!err) {
    out.general.push("The request failed.");
    return out;
  }
  const names = new Set(fields.map((f) => f.name));
  const add = (field: string, msg: string) => (out.fields[field] ??= []).push(msg);
  const issues = Array.isArray(err.details?.issues) ? (err.details.issues as { path?: string; message?: string }[]) : null;
  if (issues) {
    for (const i of issues) {
      const seg = String(i.path ?? "").replace(/^body\.?/, "").split(".")[0];
      if (seg && names.has(seg)) add(seg, String(i.message));
      else out.general.push(String(i.message));
    }
    return out;
  }
  const field = err.details?.field;
  if (typeof field === "string" && names.has(field)) add(field, String(err.message));
  else out.general.push([err.message, err.fix].filter(Boolean).join(" "));
  return out;
}

export interface FieldRenderOptions {
  errors?: string[];
  /** Title of the related record (relation fields). */
  relationTitle?: string;
  /** Org members for user pickers. */
  members?: { id: string; label: string }[];
  /** @miujs/files is available: render an upload control. */
  files?: boolean;
  /** Signed download URL for the current file. */
  fileUrl?: string;
  /** Record page URL of the related record. */
  relationHref?: string;
}

function describedBy(id: string, f: FieldMeta, errors?: string[]) {
  const ids = [f.help ? `${id}-help` : "", errors?.length ? `${id}-err` : ""].filter(Boolean).join(" ");
  return { attr: ids ? html` aria-describedby="${ids}"` : "", invalid: errors?.length ? raw(' aria-invalid="true"') : "" };
}

function label(f: FieldMeta, id: string): HtmlString {
  return html`<label for="${id}">${f.label}${f.required ? html` <span class="req" aria-hidden="true">*</span>` : ""}</label>`;
}

function chrome(f: FieldMeta, id: string, control: HtmlString, errors?: string[], legend = false): HtmlString {
  const help = f.help ? html`<p class="help" id="${id}-help">${f.help}</p>` : "";
  const err = errors?.length ? html`<p class="field-error" id="${id}-err">${errors.join("; ")}</p>` : "";
  if (legend) return html`<fieldset class="field" id="${id}"><legend>${f.label}</legend>${control}${help}${err}</fieldset>`;
  return html`<div class="field${errors?.length ? " has-error" : ""}">${label(f, id)}${control}${help}${err}</div>`;
}

function input(type: string, f: FieldMeta, id: string, value: string, extra: HtmlString | string, o: FieldRenderOptions): HtmlString {
  const d = describedBy(id, f, o.errors);
  return html`<input type="${type}"${extra} id="${id}" name="${f.name}" value="${value}"${f.required ? raw(" required") : ""}${d.invalid}${d.attr}>`;
}

const textOf = (v: unknown): string => (v === null || v === undefined ? "" : typeof v === "string" ? v : String(v));

/** The form control for one field, with label, help and error. */
export function renderField(f: FieldMeta, value: unknown, o: FieldRenderOptions = {}): HtmlString {
  const id = fieldId(f.name);
  const d = describedBy(id, f, o.errors);
  const req = f.required ? raw(" required") : "";
  const maxlen = (n?: number) => (n ? html` maxlength="${n}"` : "");
  switch (f.type) {
    case "text":
      return chrome(f, id, input("text", f, id, textOf(value), maxlen(f.max), o), o.errors);
    case "email":
      return chrome(f, id, input("email", f, id, textOf(value), "", o), o.errors);
    case "phone":
      return chrome(f, id, input("tel", f, id, textOf(value), "", o), o.errors);
    case "url":
      return chrome(f, id, input("url", f, id, textOf(value), "", o), o.errors);
    case "longText":
      return chrome(f, id, html`<textarea id="${id}" name="${f.name}" rows="4"${maxlen(f.max)}${req}${d.invalid}${d.attr}>${textOf(value)}</textarea>`, o.errors);
    case "richText": {
      const clean = sanitizeHtml(textOf(value));
      const tools = [
        ["bold", "Bold"],
        ["italic", "Italic"],
        ["insertUnorderedList", "Bulleted list"],
        ["insertOrderedList", "Numbered list"],
        ["formatBlock:h2", "Heading"],
        ["formatBlock:blockquote", "Quote"],
        ["formatBlock:pre", "Code block"],
        ["createLink", "Link"],
        ["removeFormat", "Clear formatting"],
      ];
      const control = html`<div class="rte" data-richtext="${id}">
<div class="rte-toolbar" role="toolbar" aria-label="${f.label} formatting" hidden>${tools.map(([cmd, name]) => html`<button type="button" data-cmd="${cmd}">${name}</button>`)}</div>
<div class="rte-editor" contenteditable="true" role="textbox" aria-multiline="true" aria-label="${f.label}" hidden>${raw(clean)}</div>
<textarea id="${id}" name="${f.name}" rows="6"${req}${d.invalid}${d.attr}>${clean}</textarea>
</div>`;
      return chrome(f, id, control, o.errors);
    }
    case "number": {
      const extra = html` step="${f.integer ? "1" : "any"}"${f.min !== undefined ? html` min="${f.min}"` : ""}${f.max !== undefined ? html` max="${f.max}"` : ""}`;
      return chrome(f, id, input("number", f, id, textOf(value), extra, o), o.errors);
    }
    case "percent":
      return chrome(f, id, input("number", f, id, textOf(value), html` step="any" min="0" max="100"`, o), o.errors);
    case "money": {
      const digits = f.currencyDigits ?? 2;
      const step = digits ? (1 / 10 ** digits).toFixed(digits) : "1";
      const control = html`<span class="money"><span class="unit">${f.currency ?? ""}</span>${input("number", f, id, typeof value === "string" ? value : moneyOut(value, digits), html` step="${step}"`, o)}</span>`;
      return chrome(f, id, control, o.errors);
    }
    case "boolean":
      return html`<div class="field check${o.errors?.length ? " has-error" : ""}"><input type="hidden" name="_bool" value="${f.name}"><input type="checkbox" id="${id}" name="${f.name}" value="true"${value === true ? raw(" checked") : ""}${d.invalid}${d.attr}>${label(f, id)}${f.help ? html`<p class="help" id="${id}-help">${f.help}</p>` : ""}${o.errors?.length ? html`<p class="field-error" id="${id}-err">${o.errors.join("; ")}</p>` : ""}</div>`;
    case "date":
      return chrome(f, id, input("date", f, id, typeof value === "string" ? value.slice(0, 10) : "", "", o), o.errors);
    case "datetime":
      return chrome(f, id, html`${input("datetime-local", f, id, datetimeLocal(value), "", o)} <span class="unit">UTC</span>`, o.errors);
    case "select": {
      const opts = f.options ?? [];
      const control = html`<select id="${id}" name="${f.name}"${req}${d.invalid}${d.attr}>${f.required && value ? "" : html`<option value="">—</option>`}${opts.map(
        (c) => html`<option value="${c.value}"${c.value === value ? raw(" selected") : ""}>${c.label}</option>`,
      )}</select>`;
      return chrome(f, id, control, o.errors);
    }
    case "multiSelect": {
      const chosen = Array.isArray(value) ? value : [];
      const control = html`<input type="hidden" name="_multi" value="${f.name}">${(f.options ?? []).map(
        (c, i) =>
          html`<label class="check"><input type="checkbox" id="${id}-${i}" name="${f.name}" value="${c.value}"${chosen.includes(c.value) ? raw(" checked") : ""}> ${c.label}</label>`,
      )}`;
      return chrome(f, id, control, o.errors, true);
    }
    case "tags":
      return chrome(f, id, html`${input("text", f, id, Array.isArray(value) ? value.join(", ") : "", html` data-tags="true"`, o)}<span class="hint">Comma-separated</span>`, o.errors);
    case "relation": {
      const rel = f.relation!;
      const control = html`<div class="picker" data-relation="${rel.path}" data-title-field="${rel.titleField}" data-input="${id}">${input("text", f, id, textOf(value), html` autocomplete="off"`, o)}<span class="picker-current" aria-live="polite">${
        o.relationTitle ? (o.relationHref ? html`<a href="${o.relationHref}">${o.relationTitle}</a>` : o.relationTitle) : ""
      }</span></div>`;
      return chrome(f, id, control, o.errors);
    }
    case "user": {
      if (o.members?.length) {
        const known = o.members.some((m) => m.id === value);
        const control = html`<select id="${id}" name="${f.name}"${req}${d.invalid}${d.attr}><option value="">—</option>${
          !known && typeof value === "string" && value ? html`<option value="${value}" selected>${value}</option>` : ""
        }${o.members.map((m) => html`<option value="${m.id}"${m.id === value ? raw(" selected") : ""}>${m.label}</option>`)}</select>`;
        return chrome(f, id, control, o.errors);
      }
      return chrome(f, id, input("text", f, id, textOf(value), html` autocomplete="off"`, o), o.errors);
    }
    case "file": {
      const current = typeof value === "string" && value ? html`<p class="hint">Current: ${o.fileUrl ? html`<a href="${o.fileUrl}">${value}</a>` : value} <label class="check"><input type="checkbox" name="${f.name}__clear" value="true"> Remove</label></p>` : "";
      if (o.files) return chrome(f, id, html`<input type="file" id="${id}" name="${f.name}"${d.invalid}${d.attr}>${current}`, o.errors);
      return chrome(f, id, input("text", f, id, textOf(value), "", o), o.errors);
    }
    case "json":
      return chrome(f, id, html`<textarea class="mono" id="${id}" name="${f.name}" rows="5"${req}${d.invalid}${d.attr}>${value === null || value === undefined ? "" : JSON.stringify(value, null, 2)}</textarea>`, o.errors);
    default:
      return chrome(f, id, input("text", f, id, textOf(value), "", o), o.errors);
  }
}

const EMPTY = html`<span class="muted">—</span>`;

export function badge(f: FieldMeta, v: string): HtmlString {
  const opt = f.options?.find((c) => c.value === v);
  const color = typeof opt?.color === "string" && BADGE_COLORS.includes(opt.color) ? ` c-${opt.color}` : "";
  return html`<span class="badge${color}">${opt?.label ?? v}</span>`;
}

const moneyFormats = new Map<string, Intl.NumberFormat>();
function money(v: number, f: FieldMeta): string {
  const cur = f.currency ?? "USD";
  let fmt = moneyFormats.get(cur);
  if (!fmt) {
    try {
      fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: cur });
    } catch {
      fmt = new Intl.NumberFormat("en-US", { minimumFractionDigits: f.currencyDigits ?? 2 });
    }
    moneyFormats.set(cur, fmt);
  }
  return fmt.format(v / 10 ** (f.currencyDigits ?? 2));
}

/** A value for lists, cards and read-only display. */
export function displayValue(f: FieldMeta, v: unknown, o: { title?: string; href?: string } = {}): HtmlString {
  if (v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) return EMPTY;
  switch (f.type) {
    case "money":
      return typeof v === "number" ? html`${money(v, f)}` : html`${String(v)}`;
    case "percent":
      return html`${String(v)}%`;
    case "boolean":
      return html`${v ? "Yes" : "No"}`;
    case "select":
      return badge(f, String(v));
    case "multiSelect":
      return html`${(v as unknown[]).map((x, i) => html`${i ? " " : ""}${badge(f, String(x))}`)}`;
    case "tags":
      return html`${(v as unknown[]).map((x, i) => html`${i ? " " : ""}<span class="chip">${String(x)}</span>`)}`;
    case "url":
      return /^https?:\/\//i.test(String(v)) ? html`<a href="${String(v)}" rel="noopener noreferrer nofollow">${String(v)}</a>` : html`${String(v)}`;
    case "email":
      return html`<a href="mailto:${String(v)}">${String(v)}</a>`;
    case "datetime":
      return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(v)) ? html`${String(v).slice(0, 10)} ${String(v).slice(11, 16)} UTC` : html`${String(v)}`;
    case "richText":
      // Sanitized markup with the tags removed is still escaped text.
      return raw(sanitizeHtml(String(v)).replace(/<[^>]*>/g, "").trim());
    case "json":
      return html`<code>${JSON.stringify(v).slice(0, 120)}</code>`;
    case "relation":
    case "user":
      if (o.title !== undefined) return o.href ? html`<a href="${o.href}">${o.title}</a>` : html`${o.title}`;
      return html`${String(v)}`;
    default:
      return html`${typeof v === "object" ? JSON.stringify(v) : String(v)}`;
  }
}

/** Rich text for read-only display: the engine sanitizer's output only. */
export function richText(v: unknown): HtmlString {
  return raw(sanitizeHtml(typeof v === "string" ? v : ""));
}
