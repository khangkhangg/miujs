import { Miu, type Middleware } from "../core/app.ts";
import type { Context } from "../core/context.ts";
import { HttpError, ValidationError } from "../core/errors.ts";
import { t, toJSONSchema, validate, type Issue } from "../core/schema.ts";
import { currentUser } from "../batteries/auth/auth.ts";
import { resHeaders } from "../batteries/internal.ts";
import { clampLimit, newId, type Doc } from "../batteries/data/types.ts";
import type { BlobStore } from "../batteries/files/types.ts";
import { analyseFields, createSchema, titleCase, updateSchema, visibleSchema, type FieldInfo } from "./fields.ts";
import { checkCsrf, cspNonce, issueCsrfToken } from "./security.ts";
import { serveBlob } from "../batteries/files/serve.ts";
import { uploadFiles } from "../batteries/files/upload.ts";
import { renderPage } from "./ui.ts";
import type { AdminAction, AdminOptions, AdminResource, ChangeEvent, HookContext, ObjectSchema, Permission } from "./types.ts";

const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const ACTIONS: AdminAction[] = ["list", "read", "create", "update", "delete"];
const DEFAULT_PERMISSION: Permission = ["admin"];
const META_FIELDS = ["id", "createdAt", "updatedAt"];
const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const DEFAULT_MAX_FILE = 25 * 1024 * 1024;

interface Res {
  name: string;
  label: string;
  def: AdminResource;
  fields: FieldInfo[];
  byName: Map<string, FieldInfo>;
  create: ObjectSchema;
  update: ObjectSchema;
  visible: ObjectSchema;
  hidden: string[];
  queryable: Set<string>;
  titleField: string;
  listFields: string[];
  maxFileSize: number;
}

/**
 * A schema-driven back-office: a JSON API (also exposed as MCP tools) plus a no-build web UI, mounted with
 * `app.route("/admin", admin({ resources }))`. Every route requires an authenticated user with the right role
 * (default "admin"), cookie-authenticated writes need a CSRF token and a same-origin request, and responses
 * are `no-store`. Install `sessions()` and `auth()` on the parent app (any order).
 */
export function admin(opts: AdminOptions): Miu {
  const app = new Miu();
  const prefix = opts.toolPrefix ?? "admin";
  const title = opts.title ?? "Admin";
  const trusted = opts.trustedOrigins ?? [];
  const authorize = opts.authorize ?? ((c: Context<any, any>) => currentUser(c));
  const rolesOf = opts.roles ?? defaultRoles;
  const resources = new Map<string, Res>();

  for (const [name, def] of Object.entries(opts.resources)) {
    if (!NAME.test(name)) throw new Error(`admin(): invalid resource name "${name}" (letters, digits, _ or -, starting with a letter)`);
    const fields = analyseFields(name, def);
    if (fields.some((f) => f.upload) && !def.files) throw new Error(`admin(): resource "${name}" has image/file fields but no files: BlobStore`);
    const visible = fields.filter((f) => !f.hidden);
    const titleField = def.titleField ?? visible.find((f) => f.base.kind === "string" && !f.upload)?.name ?? "id";
    resources.set(name, {
      name,
      label: def.label ?? titleCase(name),
      def,
      fields,
      byName: new Map(fields.map((f) => [f.name, f])),
      create: createSchema(fields),
      update: updateSchema(fields),
      visible: visibleSchema(fields),
      hidden: fields.filter((f) => f.hidden).map((f) => f.name),
      queryable: new Set([...META_FIELDS, ...visible.map((f) => f.name)]),
      titleField,
      listFields: def.listFields ?? visible.filter((f) => !["json", "markdown", "textarea", "file"].includes(f.widget)).slice(0, 5).map((f) => f.name),
      maxFileSize: def.maxFileSize ?? opts.maxFileSize ?? DEFAULT_MAX_FILE,
    });
  }
  for (const r of resources.values()) {
    for (const f of r.fields) {
      if (f.relation && !resources.has(f.relation.resource)) {
        throw new Error(`admin(): ${r.name}.${f.name} relates to unknown resource "${f.relation.resource}"`);
      }
    }
    for (const k of [r.titleField, ...r.listFields, ...(r.def.defaultSort ? [r.def.defaultSort.replace(/^-/, "")] : [])]) {
      if (!r.queryable.has(k)) throw new Error(`admin(): "${k}" is not a visible field of "${r.name}"`);
    }
  }

  // ---------- middleware ----------

  const secure: Middleware = async (c, next) => {
    await next();
    const h = resHeaders(c);
    h.set("cache-control", "no-store");
    if (!h.has("x-content-type-options")) h.set("x-content-type-options", "nosniff");
    if (!h.has("referrer-policy")) h.set("referrer-policy", "same-origin");
  };

  const guard = (page: boolean): Middleware => async (c, next) => {
    const user = await authorize(c);
    if (!user) {
      if (page && opts.loginUrl && (c.req.headers.get("accept") ?? "").includes("text/html")) {
        const sep = opts.loginUrl.includes("?") ? "&" : "?";
        return c.redirect(`${opts.loginUrl}${sep}next=${encodeURIComponent(c.url.pathname + c.url.search)}`);
      }
      throw new HttpError(401, "Authentication required: sign in, or send `Authorization: Bearer <token>`.", {
        code: "unauthenticated",
        headers: { "www-authenticate": "Bearer" },
      });
    }
    c.set("adminUser", user);
    await checkCsrf(c, trusted);
    return next();
  };
  const use = [secure, guard(false)];

  // ---------- helpers ----------

  const permissionFor = (r: Res, action: AdminAction): Permission =>
    r.def.permissions?.[action] ?? opts.permissions?.[action] ?? DEFAULT_PERMISSION;

  const allowed = async (c: Context<any, any>, r: Res, action: AdminAction, doc?: Doc): Promise<boolean> => {
    const p = permissionFor(r, action);
    const user = c.get("adminUser");
    if (typeof p === "function") return !!(await p(user, { action, resource: r.name, doc, c }));
    const roles = rolesOf(user) ?? [];
    return p.some((role) => roles.includes(role));
  };

  const demand = async (c: Context<any, any>, r: Res, action: AdminAction, doc?: Doc) => {
    if (!(await allowed(c, r, action, doc))) {
      throw new HttpError(403, `You may not ${action} ${r.label}`, { code: "forbidden" });
    }
  };

  /** Role checks run before loading (no existence leak); predicates see the record. */
  const loadFor = async (c: Context<any, any>, r: Res, action: AdminAction, id: string): Promise<Doc> => {
    const predicate = typeof permissionFor(r, action) === "function";
    if (!predicate) await demand(c, r, action);
    const doc = await r.def.repo.get(id);
    if (!doc) throw new HttpError(404, `${r.label}: no record with id ${JSON.stringify(id)}`, { code: "not_found" });
    if (predicate) await demand(c, r, action, doc);
    return doc;
  };

  const clean = (r: Res, doc: Doc): Doc => {
    if (!r.hidden.length) return doc;
    const out = { ...doc } as Record<string, unknown>;
    for (const k of r.hidden) delete out[k];
    return out as unknown as Doc;
  };

  const hookCtx = (c: Context<any, any>, r: Res, before?: Doc): HookContext => ({ c, user: c.get("adminUser"), resource: r.name, before });

  const record = async (c: Context<any, any>, r: Res, action: ChangeEvent["action"], id: string, changes: unknown) => {
    if (!opts.audit) return;
    const user = c.get("adminUser") as { id?: unknown } | undefined;
    await opts.audit.create({ at: new Date().toISOString(), user: String(user?.id ?? ""), action, resource: r.name, recordId: id, changes });
  };

  const checkRelations = async (r: Res, data: Record<string, unknown>) => {
    const issues: Issue[] = [];
    for (const f of r.fields) {
      const v = data[f.name];
      if (!f.relation || typeof v !== "string" || v === "") continue;
      const target = resources.get(f.relation.resource)!;
      if (!(await target.def.repo.get(v))) issues.push({ path: ["body", f.name], message: `No ${target.label} record with id ${JSON.stringify(v)}` });
    }
    if (issues.length) throw new ValidationError(issues);
  };

  const parseWhere = (c: Context<any, any>, r: Res): Record<string, string | number | boolean | null> | undefined => {
    const raw: [string, unknown][] = [];
    for (const [k, v] of c.url.searchParams) {
      const m = /^filter\[([^\]]+)\]$/.exec(k);
      if (m) raw.push([m[1]!, v]);
    }
    const json = c.url.searchParams.get("filter");
    if (json) {
      let obj: unknown;
      try {
        obj = JSON.parse(json);
      } catch {
        throw new HttpError(400, "filter must be a JSON object", { code: "invalid_filter" });
      }
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new HttpError(400, "filter must be a JSON object", { code: "invalid_filter" });
      raw.push(...Object.entries(obj));
    }
    if (!raw.length) return undefined;
    const where: Record<string, string | number | boolean | null> = {};
    const issues: Issue[] = [];
    for (const [field, v] of raw) {
      if (!r.queryable.has(field)) throw new HttpError(400, `Unknown filter field: ${field}`, { code: "invalid_filter" });
      const f = r.byName.get(field);
      if (!f) {
        where[field] = String(v);
        continue;
      }
      if ((v === null || v === "null") && (f.optional || f.nullable)) {
        where[field] = null;
        continue;
      }
      const res = validate(f.base, v, { coerce: true });
      if (!res.ok || (res.value !== null && typeof res.value === "object")) {
        issues.push({ path: ["query", "filter", field], message: res.ok ? "Expected a scalar value" : res.issues[0]!.message });
      } else where[field] = res.value as string | number | boolean;
    }
    if (issues.length) throw new ValidationError(issues);
    return where;
  };

  const fieldMeta = (r: Res) => {
    const out: Record<string, unknown> = {};
    for (const f of r.fields) {
      if (f.hidden) continue;
      out[f.name] = {
        label: f.label,
        widget: f.widget,
        required: !f.optional && !f.hasDefault,
        readOnly: f.readOnly,
        nullable: f.nullable || f.optional,
        ...(f.upload ? { upload: true } : {}),
        ...(f.options ? { options: f.options } : {}),
        ...(f.relation ? { relation: f.relation } : {}),
        ...(f.help ? { help: f.help } : {}),
      };
    }
    return out;
  };

  const resOf = (name: string) => resources.get(name)!;
  const uploadField = (r: Res, field: string): FieldInfo => {
    const f = r.byName.get(field);
    if (!f || !f.upload || f.hidden) throw new HttpError(404, `${r.label} has no file field ${JSON.stringify(field)}`, { code: "not_found" });
    return f;
  };
  const fileKeyPrefix = (r: Res, f: FieldInfo) => `${r.name}/${f.name}/`;

  // ---------- routes ----------

  const idParams = t.object({ id: t.string({ min: 1 }) });
  const listQuery = t.object({
    q: t.optional(t.string({ description: "Case-insensitive search" })),
    sort: t.optional(t.string({ description: 'Field to sort by; prefix with "-" for descending' })),
    limit: t.optional(t.integer({ min: 1, max: 1000, description: "Page size (default 50)" })),
    offset: t.optional(t.integer({ min: 0 })),
    filter: t.optional(t.string({ description: 'JSON object of exact-match filters, e.g. {"status":"published"} (or filter[field]=value)' })),
  });

  app.get("/", { use: [secure, guard(true)], tool: false, hidden: true }, (c) => {
    const nonce = cspNonce();
    return new Response(renderPage({ title, nonce, loginUrl: opts.loginUrl }), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": [
          "default-src 'self'",
          `script-src 'nonce-${nonce}'`,
          `style-src 'self' 'nonce-${nonce}'`,
          "img-src 'self' blob: data:",
          "connect-src 'self'",
          "object-src 'none'",
          "base-uri 'none'",
          "form-action 'self'",
          "frame-ancestors 'none'",
        ].join("; "),
        "x-frame-options": "DENY",
        "cross-origin-opener-policy": "same-origin",
      },
    });
  });

  app.get("/api/_csrf", { use, tool: false, hidden: true, summary: "CSRF token for cookie-authenticated admin writes" }, async (c) => ({
    token: await issueCsrfToken(c),
  }));

  app.get(
    "/api/_meta",
    {
      use,
      tags: ["admin"],
      summary: "Describe the admin resources",
      description: "Resources the caller may manage, with JSON Schema, field widgets and the caller's permissions.",
      tool: { name: `${prefix}_meta` },
    },
    async (c) => {
      const user = c.get("adminUser") as Record<string, unknown>;
      const list = [];
      for (const r of resources.values()) {
        if (!(await allowed(c, r, "list"))) continue;
        const permissions: Record<string, boolean> = {};
        for (const a of ACTIONS) permissions[a] = await allowed(c, r, a);
        list.push({
          name: r.name,
          label: r.label,
          titleField: r.titleField,
          listFields: r.listFields,
          searchFields: r.def.searchFields ?? [],
          defaultSort: r.def.defaultSort ?? null,
          maxFileSize: r.maxFileSize,
          schema: toJSONSchema(r.visible),
          fields: fieldMeta(r),
          permissions,
        });
      }
      if (!list.length) throw new HttpError(403, "You may not use this admin", { code: "forbidden" });
      return {
        title,
        user: {
          id: String(user.id ?? ""),
          name: String(user.name ?? user.email ?? user.username ?? user.id ?? ""),
          roles: [...(rolesOf(user) ?? [])],
        },
        resources: list,
      };
    },
  );

  for (const name of resources.keys()) {
    const r = resOf(name);
    const slug = name.replace(/-/g, "_");
    const base = `/api/${name}`;
    const tags = ["admin"];

    app.get(
      base,
      { use, tags, query: listQuery, summary: `List ${r.label}`, tool: { name: `${prefix}_list_${slug}`, description: `List, search, sort and filter ${r.label} records.` } },
      async (c) => {
        await demand(c, r, "list");
        const q = c.query as { q?: string; sort?: string; limit?: number; offset?: number };
        const sort = q.sort || r.def.defaultSort;
        if (sort && !r.queryable.has(sort.replace(/^-/, ""))) throw new HttpError(400, `Unknown sort field: ${sort}`, { code: "invalid_sort" });
        const where = parseWhere(c, r);
        const limit = clampLimit(q.limit);
        const offset = q.offset ?? 0;
        const out = await r.def.repo.list({ q: q.q || undefined, sort, where, limit, offset });
        return { items: out.items.map((d) => clean(r, d)), total: out.total, limit, offset };
      },
    );

    app.get(
      `${base}/:id`,
      { use, tags, params: idParams, summary: `Get one ${r.label} record`, tool: { name: `${prefix}_get_${slug}` } },
      async (c) => clean(r, await loadFor(c, r, "read", c.params.id)),
    );

    app.post(
      base,
      { use, tags, body: r.create, summary: `Create a ${r.label} record`, tool: { name: `${prefix}_create_${slug}` } },
      async (c) => {
        await demand(c, r, "create");
        let data = { ...(c.body as Record<string, unknown>) };
        // Server-owned fields (readOnly/hidden) are not accepted from the client but still get their defaults.
        for (const f of r.fields) {
          if ((f.readOnly || f.hidden) && f.hasDefault && !(f.name in data)) data[f.name] = structuredClone(f.defaultValue);
        }
        await checkRelations(r, data);
        const ctx = hookCtx(c, r);
        if (r.def.hooks?.beforeCreate) {
          const out = await r.def.hooks.beforeCreate(data, ctx);
          if (out && typeof out === "object") data = out as Record<string, unknown>;
        }
        const doc = await r.def.repo.create(data as never);
        await record(c, r, "create", doc.id, clean(r, doc));
        await r.def.hooks?.afterChange?.({ action: "create", after: doc }, ctx);
        return c.json(clean(r, doc), 201);
      },
    );

    app.patch(
      `${base}/:id`,
      { use, tags, params: idParams, body: r.update, summary: `Update a ${r.label} record (partial)`, tool: { name: `${prefix}_update_${slug}`, description: `Update fields of a ${r.label} record; null clears an optional field.` } },
      async (c) => {
        const id = c.params.id;
        const before = await loadFor(c, r, "update", id);
        let patch: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(c.body as Record<string, unknown>)) {
          const f = r.byName.get(k)!;
          patch[k] = v === null && f.optional && !f.nullable ? undefined : v;
        }
        await checkRelations(r, patch);
        const ctx = hookCtx(c, r, before);
        if (r.def.hooks?.beforeUpdate) {
          const out = await r.def.hooks.beforeUpdate(patch, ctx);
          if (out && typeof out === "object") patch = out as Record<string, unknown>;
        }
        // A patch that sets nothing new (e.g. only read-only/unknown fields, which are stripped) is a no-op:
        // no write, no updatedAt bump, no audit entry.
        const prev = before as unknown as Record<string, unknown>;
        if (Object.entries(patch).every(([k, v]) => sameValue(prev[k], v))) return clean(r, before);
        const after = await r.def.repo.update(id, patch as never);
        if (!after) throw new HttpError(404, `${r.label}: no record with id ${JSON.stringify(id)}`, { code: "not_found" });
        const changes: Record<string, { from: unknown; to: unknown }> = {};
        const b = before as unknown as Record<string, unknown>;
        const a = after as unknown as Record<string, unknown>;
        for (const k of Object.keys(patch)) {
          if (r.hidden.includes(k)) continue;
          if (JSON.stringify(b[k]) !== JSON.stringify(a[k])) changes[k] = { from: b[k], to: a[k] };
        }
        await record(c, r, "update", id, changes);
        await r.def.hooks?.afterChange?.({ action: "update", before, after }, ctx);
        return clean(r, after);
      },
    );

    app.delete(
      `${base}/:id`,
      { use, tags, params: idParams, summary: `Delete a ${r.label} record`, tool: { name: `${prefix}_delete_${slug}` } },
      async (c) => {
        const id = c.params.id;
        const before = await loadFor(c, r, "delete", id);
        if (!(await r.def.repo.delete(id))) throw new HttpError(404, `${r.label}: no record with id ${JSON.stringify(id)}`, { code: "not_found" });
        const store = r.def.files;
        if (store) {
          for (const f of r.fields) {
            const key = (before as unknown as Record<string, unknown>)[f.name];
            if (f.upload && typeof key === "string" && key.startsWith(fileKeyPrefix(r, f))) await store.delete(key).catch(() => false);
          }
        }
        await record(c, r, "delete", id, clean(r, before));
        await r.def.hooks?.afterChange?.({ action: "delete", before }, hookCtx(c, r, before));
        return undefined;
      },
    );

    if (!r.fields.some((f) => f.upload)) continue;
    const store = r.def.files as BlobStore;
    const fileParams = t.object({ id: t.string({ min: 1 }), field: t.string({ min: 1 }) });

    app.post(
      `${base}/:id/files/:field`,
      { use, tags, params: fileParams, tool: false, summary: `Upload a file to a ${r.label} image/file field (multipart field "file")` },
      async (c) => {
        const { id, field } = c.params;
        const f = uploadField(r, field);
        const before = await loadFor(c, r, "update", id);
        let filename = "upload";
        const [stored] = await uploadFiles(c, store, {
          maxBytes: r.maxFileSize,
          requireImage: f.widget === "image",
          // Images: sniffed formats only. Files: anything, but unrecognised bytes are stored as octet-stream.
          allowed: f.widget === "image" ? undefined : ["image/*", "application/*"],
          key: (_file, info) => `${fileKeyPrefix(r, f)}${newId()}.${info.ext}`,
          metadata: (info) => {
            filename = safeFilename(info.name);
            return { filename, ...(info.image ? { width: String(info.image.width), height: String(info.image.height) } : {}) };
          },
        });
        const key = stored!.key;
        const after = await r.def.repo.update(id, { [f.name]: key } as never);
        if (!after) {
          await store.delete(key).catch(() => false);
          throw new HttpError(404, `${r.label}: no record with id ${JSON.stringify(id)}`, { code: "not_found" });
        }
        const old = (before as unknown as Record<string, unknown>)[f.name];
        if (typeof old === "string" && old !== key && old.startsWith(fileKeyPrefix(r, f))) await store.delete(old).catch(() => false);
        const file = { ...stored!, filename };
        await record(c, r, "upload", id, { field: f.name, ...file });
        await r.def.hooks?.afterChange?.({ action: "upload", before, after }, hookCtx(c, r, before));
        return { item: clean(r, after), file };
      },
    );

    app.get(
      `${base}/:id/files/:field`,
      { use, tags, params: fileParams, tool: false, summary: `Download the file stored in a ${r.label} field` },
      async (c) => {
        const { id, field } = c.params;
        const f = uploadField(r, field);
        const doc = await loadFor(c, r, "read", id);
        const key = (doc as unknown as Record<string, unknown>)[f.name];
        if (typeof key !== "string" || !key.startsWith(fileKeyPrefix(r, f))) throw new HttpError(404, "No file stored in this field", { code: "not_found" });
        const download = f.widget === "image" ? undefined : ((await store.head(key))?.metadata?.filename ?? key.split("/").pop()!);
        const res = await serveBlob(c, store, key, { download });
        if (f.widget !== "image" || !IMAGE_MIME.has(res.headers.get("content-type") ?? "")) res.headers.set("content-type", "application/octet-stream");
        // Defence in depth: user uploads never run script on the admin's origin, even if opened directly.
        res.headers.set("content-security-policy", "default-src 'none'; sandbox");
        return res;
      },
    );
  }

  return app;
}

/** Strip paths and unusual characters from a client-supplied file name (display/download only). */
function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  return base.replace(/[^\w.\- ]+/g, "_").replace(/^\.+/, "").slice(0, 100).trim() || "upload";
}

function defaultRoles(user: any): readonly string[] {
  if (Array.isArray(user?.roles)) return user.roles;
  if (typeof user?.role === "string") return [user.role];
  return [];
}

/** Structural equality for JSON-like field values (no-op detection on update). */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null || typeof a !== "object" || typeof b !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
