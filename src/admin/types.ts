import type { Context } from "../core/context.ts";
import type { TSchema } from "../core/schema.ts";
import type { Doc, Repository } from "../batteries/data/types.ts";
import type { BlobStore } from "../batteries/files/types.ts";

export type AdminAction = "list" | "read" | "create" | "update" | "delete";

export type ObjectSchema = Extract<TSchema, { kind: "object" }>;

export interface PermissionContext {
  action: AdminAction;
  resource: string;
  /** The record, for read/update/delete. Undefined for collection-level checks (list, create, `_meta`). */
  doc?: Doc;
  c: Context<any, any>;
}

/** Roles allowed to perform an action, or a predicate. */
export type Permission = readonly string[] | ((user: any, ctx: PermissionContext) => boolean | Promise<boolean>);

export type Widget =
  | "text" | "textarea" | "markdown" | "number" | "checkbox" | "select" | "date" | "datetime"
  | "image" | "file" | "relation" | "json";

export interface FieldOptions {
  widget?: Widget;
  label?: string;
  /** Help text shown under the input. */
  help?: string;
  /** For `widget: "relation"`: the related resource and the field shown as its label. */
  relation?: { resource: string; labelField: string };
  /** Shown but never writable through the API (hooks may still set it). */
  readOnly?: boolean;
  /** Never returned by the API nor writable (e.g. password hashes). */
  hidden?: boolean;
}

export interface HookContext {
  c: Context<any, any>;
  user: any;
  resource: string;
  /** The stored record before an update. */
  before?: Doc;
}

export interface ChangeEvent {
  action: "create" | "update" | "delete" | "upload";
  before?: Doc;
  after?: Doc;
}

export interface AdminResource<T extends Doc = any> {
  /** `t.object({...})` describing the editable document (without id/createdAt/updatedAt). */
  schema: ObjectSchema;
  repo: Repository<T>;
  label?: string;
  /** Field used as a record's title in lists and relation pickers. Default: first string field. */
  titleField?: string;
  /** Columns in the list view. Default: up to 5 visible fields. */
  listFields?: string[];
  /** Shown as the search hint; the repository decides which fields `q` searches. */
  searchFields?: string[];
  /** Default list order, e.g. "-createdAt". */
  defaultSort?: string;
  fields?: Record<string, FieldOptions>;
  /** Where `image`/`file` fields are stored. Required when the resource has such fields. */
  files?: BlobStore;
  /** Per-upload byte limit. Default: the admin's `maxFileSize` (25 MiB). */
  maxFileSize?: number;
  /** Per-action permissions. Default: the admin's `permissions`, else role "admin". */
  permissions?: Partial<Record<AdminAction, Permission>>;
  hooks?: {
    /** Return a replacement (or mutate and return nothing). Throw an HttpError to reject. */
    beforeCreate?: (data: Record<string, unknown>, ctx: HookContext) => unknown;
    beforeUpdate?: (patch: Record<string, unknown>, ctx: HookContext) => unknown;
    afterChange?: (event: ChangeEvent, ctx: HookContext) => unknown;
  };
}

export interface AuditEntry {
  at: string;
  /** The acting user's id. */
  user: string;
  action: ChangeEvent["action"];
  resource: string;
  /** The changed record's id (named so it never collides with the audit repository's own `id`). */
  recordId: string;
  /** create: the new data; update: `{ field: { from, to } }`; delete: the removed record; upload: file info. */
  changes: unknown;
}

export interface AdminOptions {
  resources: Record<string, AdminResource<any>>;
  /** Shown in the UI header and page title. Default "Admin". */
  title?: string;
  /** Resolve the acting user. Default: `currentUser(c)` (set by the `auth()` middleware). */
  authorize?: (c: Context<any, any>) => unknown | Promise<unknown>;
  /** A user's roles. Default: `user.roles` (array) or `[user.role]`. */
  roles?: (user: any) => readonly string[];
  /** Default permissions for every resource. Default: role "admin" for everything. */
  permissions?: Partial<Record<AdminAction, Permission>>;
  /** Receives one entry per change. */
  audit?: Repository<any>;
  /** Browsers (Accept: text/html) that open the UI signed out are redirected here with `?next=`. */
  loginUrl?: string;
  /** MCP tool name prefix: `admin_list_tours`. Default "admin". */
  toolPrefix?: string;
  /**
   * Extra origins allowed to send cookie-authenticated writes (e.g. the public origin when a proxy rewrites
   * the Host). The request's own origin is always allowed.
   */
  trustedOrigins?: string[];
  /** Default upload limit in bytes. Default 25 MiB. */
  maxFileSize?: number;
}
