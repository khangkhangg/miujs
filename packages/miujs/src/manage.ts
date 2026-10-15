// The management contract: how a plugin describes what an operator can see and do with it.
// @miujs/admin renders these sections (status, lists, settings, actions) for every plugin that
// has them, checks permissions, audits every change and offers the actions as MCP tools. A
// plugin never depends on @miujs/admin; it only returns plain data and functions.

import type { Context } from "./context.ts";
import type { Schema } from "./schema.ts";

type MaybePromise<T> = T | Promise<T>;

/** A JSON-serializable value shown in a cell or a stat. */
export type ManageValue = string | number | boolean | null;

export interface ManageStat {
  label: string;
  value: ManageValue;
  /** Short explanation, shown as a tooltip or a second line. */
  hint?: string;
  /** "good" | "warning" | "critical" colors the stat; omit for neutral. */
  tone?: "good" | "warning" | "critical";
  /**
   * Rendering hint, as for a column: "bytes" (a byte count), "duration" (milliseconds), "date"
   * (epoch milliseconds or an ISO string), "boolean", "code", "number" or "text". Default "text".
   */
  type?: "text" | "number" | "bytes" | "date" | "duration" | "boolean" | "code";
}

export interface ManageColumn {
  key: string;
  label: string;
  /** Rendering hint. Default "text". */
  type?: "text" | "number" | "bytes" | "date" | "duration" | "boolean" | "code";
}

export interface ManageTable {
  title: string;
  columns: ManageColumn[];
  rows: Record<string, ManageValue>[];
}

/** Read-only snapshot of a section. Keep it cheap: it is fetched when the page opens. */
export interface ManageStatus {
  stats?: ManageStat[];
  tables?: ManageTable[];
}

/** Something an operator can do. Every run is permission-checked and audited by the admin. */
export interface ManageAction<I = any> {
  /** Stable identifier, `[a-z][a-zA-Z0-9_]*`. Becomes part of the permission and the MCP tool name. */
  name: string;
  title: string;
  description?: string;
  /** Validated before `run`; also the form the UI shows and the MCP tool's input schema. */
  input?: Schema<I>;
  /** Ask for confirmation in the UI and mark the MCP tool destructive. */
  danger?: boolean;
  /** Returns a short message or JSON-serializable data shown to the operator. */
  run(input: I, ctx: Context): MaybePromise<unknown>;
}

export interface ManageListQuery {
  /** Opaque cursor from the previous page's `next`. */
  cursor?: string;
  /** Page size; the admin caps it at 100. */
  limit: number;
  /** Free-text search, when `searchable`. */
  search?: string;
  /** Values for the list's `filters`. */
  filters?: Record<string, string>;
}

/** Records that can be paged through, e.g. queued jobs, sessions, rooms, files. */
export interface ManageList {
  name: string;
  title: string;
  columns: ManageColumn[];
  /** Column whose value identifies a row for `rowActions`. */
  idKey: string;
  searchable?: boolean;
  filters?: { key: string; label: string; options: string[] }[];
  list(q: ManageListQuery, ctx: Context): MaybePromise<{ rows: Record<string, ManageValue>[]; next?: string }>;
  /** Actions on one row; they receive `{ id }` merged into their input. */
  rowActions?: ManageAction<any>[];
}

/** Runtime settings an operator can change without a deploy. */
export interface ManageSettings<S = any> {
  schema: Schema<S>;
  get(ctx: Context): MaybePromise<S>;
  /** Apply new values (already validated). The admin persists them and re-applies on startup. */
  set(value: S, ctx: Context): MaybePromise<void>;
}

export interface ManageSection {
  /** Stable identifier, `[a-z][a-z0-9-]*`, unique within the plugin. */
  id: string;
  title: string;
  description?: string;
  status?(ctx: Context): MaybePromise<ManageStatus>;
  lists?: ManageList[];
  settings?: ManageSettings;
  actions?: ManageAction<any>[];
}
