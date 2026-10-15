// The audit() plugin: ctx.audit.log / ctx.audit.query, GET /audit, and optional auth-event logging.

import { definePlugin, errors, route, t, type CloudflareNeeds, type Context } from "miujs";
import { diff, redact, redactor, type RedactRule } from "./diff.ts";
import type { AuditPage, AuditQuery, AuditRecord, AuditStore } from "./store.ts";

export interface AuditEntry {
  /** What happened, e.g. `"update"`, `"export"`, `"view"`. */
  action: string;
  /** What it happened to, e.g. `"contacts"`, `"patients"`. */
  resource: string;
  resourceId?: string | number | null;
  /** State before the change. With `after`, only changed fields are stored. */
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
}

export interface AuditClient {
  /** Appends an entry with the actor, org, ip, user agent, request id and time of this request. */
  log(entry: AuditEntry): Promise<AuditRecord>;
  /** Reads the log. No permission check: guard your own routes (GET /audit does). */
  query(q?: AuditQuery): Promise<AuditPage>;
}

export interface AuditOptions {
  /** `memoryAuditStore()` for dev, `dbAuditStore(database)` for real apps. */
  store: AuditStore;
  /** Extra keys to redact, on top of password/token/secret/apiKey/authorization/ssn/…. */
  redact?: RedactRule[];
  /** Log auth_login / auth_logout / auth_register outcomes. Default false. */
  auth?: boolean;
  /** Needed for GET /audit when `ctx.can` exists (e.g. @miujs/access). Default `"audit:read"`. Without `ctx.can`, the `admin` role is required. */
  permission?: string;
  /** Serve GET /audit. Default true. */
  routes?: boolean;
  /** Default `/audit`. */
  path?: string;
}

declare module "miujs" {
  interface Context {
    /** Tamper-evident audit log from `@miujs/audit`. */
    audit: AuditClient;
  }
}

const AUTH_ROUTES: Record<string, string> = { auth_login: "auth.login", auth_logout: "auth.logout", auth_register: "auth.register" };

/** Reads `ctx.org.id` without depending on @miujs/access. */
function orgOf(ctx: Context): string | null {
  const org = (ctx as { org?: { id?: unknown } | null }).org;
  return org && typeof org.id === "string" ? org.id : null;
}

/**
 * Audit trail:
 *
 * ```ts
 * miu({ plugins: [session(), auth(), access({ roles }), audit({ store: dbAuditStore(d1("DB")), auth: true })] })
 * await ctx.audit.log({ action: "update", resource: "patients", resourceId: id, before, after });
 * ```
 */
export function audit(opts: AuditOptions) {
  const store = opts?.store;
  if (!store || typeof store.append !== "function") {
    throw errors.config("MIU_E_AUDIT_STORE_MISSING", "audit() needs a store", "Pass audit({ store: dbAuditStore(database) }) (or memoryAuditStore() in tests).");
  }
  const isSecret = redactor(opts.redact ?? []);
  const permission = opts.permission ?? "audit:read";
  const path = opts.path ?? "/audit";

  function write(ctx: Context, entry: AuditEntry): Promise<AuditRecord> {
    if (!entry || typeof entry !== "object") {
      throw errors.custom({ code: "MIU_E_AUDIT_INVALID", status: 500, message: "Invalid audit entry: expected an object", fix: 'Call ctx.audit.log({ action: "update", resource: "contacts", ... }).' });
    }
    const hasDiff = entry.before !== undefined || entry.after !== undefined;
    return store.append(
      {
        ts: Date.now(),
        action: entry.action,
        resource: entry.resource,
        resourceId: entry.resourceId ?? null,
        actor: ctx.user?.id ?? null,
        org: orgOf(ctx),
        ip: ctx.ip ?? null,
        userAgent: ctx.headers.get("user-agent"),
        requestId: ctx.requestId,
        changes: hasDiff ? (redact(diff(entry.before, entry.after), isSecret) as AuditRecord["changes"]) : null,
        metadata: entry.metadata ? (redact(entry.metadata, isSecret) as Record<string, unknown>) : null,
      },
      ctx.env,
    );
  }

  const queryRoute = route.get(path, {
    name: "audit_query",
    summary: `Search the audit log, newest first (needs ${permission}; limited to the active organization when one is selected)`,
    tags: ["audit"],
    auth: "required",
    query: t.object({
      resource: t.optional(t.string({ maxLength: 200 })),
      resourceId: t.optional(t.string({ maxLength: 200 })),
      actor: t.optional(t.string({ maxLength: 200 })),
      org: t.optional(t.string({ maxLength: 200 })),
      since: t.optional(t.string({ maxLength: 40 })),
      until: t.optional(t.string({ maxLength: 40 })),
      limit: t.optional(t.integer({ min: 1, max: 1000 })),
      cursor: t.optional(t.string({ maxLength: 20 })),
    }),
    response: t.object({ items: t.array(t.unknown()), nextCursor: t.nullable(t.string()) }),
    handler: async (ctx) => {
      const c = ctx as unknown as Context;
      const can = (c as { can?: unknown }).can;
      const allowed = typeof can === "function" ? (can as (p: string) => unknown)(permission) === true : ctx.user.roles?.includes("admin") === true;
      if (!allowed) {
        throw errors.forbidden(
          "You may not read the audit log",
          typeof can === "function" ? `Your role needs the "${permission}" permission.` : `Sign in as a user with the "admin" role (or add @miujs/access and grant "${permission}").`,
        );
      }
      const q: AuditQuery = { ...ctx.query };
      const active = orgOf(c);
      if (active) {
        if (q.org !== undefined && q.org !== active) {
          throw errors.custom({
            code: "MIU_E_AUDIT_ORG_MISMATCH",
            status: 403,
            message: "You can only read the audit log of the active organization",
            fix: "Drop the org filter, or select that organization (x-org-id) if you belong to it.",
          });
        }
        q.org = active;
      }
      return store.query(q, c.env);
    },
  });

  return definePlugin({
    name: "audit",
    routes: opts.routes === false ? [] : [queryRoute],
    setup(app) {
      if (!app.dev && store.kind === "memory") app.log.warn("audit() is using memoryAuditStore() in production; entries are lost on restart. Use dbAuditStore().");
    },
    onRequest(ctx) {
      (ctx as { audit: AuditClient }).audit = {
        log: (entry) => write(ctx, entry),
        query: (q = {}) => store.query(q, ctx.env),
      };
    },
    async onResponse(ctx, res) {
      if (!opts.auth) return;
      const action = ctx.route ? AUTH_ROUTES[ctx.route.name] : undefined;
      if (!action) return;
      const ok = res.status < 400;
      const metadata: Record<string, unknown> = { outcome: ok ? "success" : "failure", status: res.status };
      try {
        if (!ok && (res.headers.get("content-type") ?? "").includes("json")) {
          const code = ((await res.clone().json()) as { error?: { code?: unknown } })?.error?.code;
          if (typeof code === "string") metadata.code = code;
        }
        // The attempted email helps spot brute force; the password is never read.
        const email = (ctx.body as { email?: unknown } | undefined)?.email;
        if (!ok && typeof email === "string") metadata.email = email.trim().toLowerCase().slice(0, 254);
        await write(ctx, { action, resource: "auth", resourceId: ctx.user?.id ?? null, metadata });
      } catch (err) {
        ctx.log.error("audit: could not record auth event", { err, action });
      }
    },
    inspect() {
      return { store: store.inspect?.() ?? { store: store.kind }, auth: !!opts.auth, permission, redact: (opts.redact ?? []).map(String), path: opts.routes === false ? null : path };
    },
    cloudflare(): CloudflareNeeds {
      return store.cloudflare?.() ?? {};
    },
  });
}
