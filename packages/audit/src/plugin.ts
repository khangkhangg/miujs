// The audit() plugin: ctx.audit.log / ctx.audit.query, GET /audit, and optional auth-event logging.

import { definePlugin, errors, processEnv, route, t, type CloudflareNeeds, type Context, type Env } from "miujs";
import { diff, redact, redactor, type RedactRule } from "./diff.ts";
import { checkKeys, ENV_KEY, envKeys, hashAuditEmail, MIN_KEY_LENGTH, type AuditKeys } from "./keys.ts";
import { storeKeys, type AuditInput, type AuditPage, type AuditQuery, type AuditRecord, type AuditStore } from "./store.ts";

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
  /** Appends several entries as consecutive rows (one transaction on the built-in stores). */
  logMany(entries: AuditEntry[]): Promise<AuditRecord[]>;
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
  /**
   * HMAC key(s) for the hash chain (min 32 chars; first signs, all verify). Default:
   * `env.AUDIT_HMAC_KEY` (comma-separated, newest first). Without a key the chain is plain SHA-256,
   * which anyone with database write access can recompute.
   */
  key?: AuditKeys;
  /**
   * For `auth: true`: store `emailHash` (an HMAC of the normalized address, see `hashAuditEmail`)
   * instead of the attempted email on failed sign-ins. Default false.
   */
  redactFailedLoginEmail?: boolean;
  /** Salt for `emailHash` (min 32 chars). Default: the audit key. With neither, the email is dropped. */
  emailSalt?: string;
}

declare module "miujs" {
  interface Context {
    /** Tamper-evident audit log from `@miujs/audit`. */
    audit: AuditClient;
  }
  interface Services {
    /** Audit logging outside requests, from `@miujs/audit`. */
    audit: AuditService;
  }
}

/** Who an entry is attributed to outside a request. */
export interface SystemActor {
  /** Default "system". */
  actor?: string;
  org?: string | null;
  /** Env for the store (Workers bindings, AUDIT_HMAC_KEY). Default: the process env. */
  env?: Env;
}

/** `app.service("audit")`: audit logging for code outside a request (jobs, workflows, scripts). */
export interface AuditService {
  log(entry: AuditEntry, who?: SystemActor): Promise<AuditRecord>;
  logMany(entries: AuditEntry[], who?: SystemActor): Promise<AuditRecord[]>;
  query(q?: AuditQuery, env?: Env): Promise<AuditPage>;
}

interface Origin {
  actor: string | null;
  org: string | null;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
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
  if (opts.key !== undefined) checkKeys(opts.key);
  if (opts.emailSalt !== undefined && (typeof opts.emailSalt !== "string" || opts.emailSalt.length < MIN_KEY_LENGTH)) {
    throw errors.config("MIU_E_AUDIT_KEY_WEAK", "audit({ emailSalt }) is too short", `Use a random secret of at least ${MIN_KEY_LENGTH} characters, or omit it to reuse the audit key.`);
  }
  const appendOpts = opts.key === undefined ? {} : { key: opts.key };
  const keyed = (env: Env) => opts.key !== undefined || storeKeys(store) !== undefined || envKeys(env) !== null;
  /** Salt for failed-login email hashes: emailSalt, else the signing audit key. */
  const emailSalt = (env: Env): string | null => {
    if (opts.emailSalt) return opts.emailSalt;
    const k = opts.key ?? storeKeys(store) ?? envKeys(env);
    const first = k === undefined || k === null ? undefined : Array.isArray(k) ? k[0] : k;
    return first === undefined ? null : typeof first === "string" ? first : first.secret;
  };
  let warnedNoKey = false;
  const isSecret = redactor(opts.redact ?? []);
  const permission = opts.permission ?? "audit:read";
  const path = opts.path ?? "/audit";

  function toInput(entry: AuditEntry, origin: Origin): AuditInput {
    if (!entry || typeof entry !== "object") {
      throw errors.custom({ code: "MIU_E_AUDIT_INVALID", status: 500, message: "Invalid audit entry: expected an object", fix: 'Call ctx.audit.log({ action: "update", resource: "contacts", ... }).' });
    }
    const hasDiff = entry.before !== undefined || entry.after !== undefined;
    return {
      ts: Date.now(),
      action: entry.action,
      resource: entry.resource,
      resourceId: entry.resourceId ?? null,
      ...origin,
      changes: hasDiff ? (redact(diff(entry.before, entry.after), isSecret) as AuditRecord["changes"]) : null,
      metadata: entry.metadata ? (redact(entry.metadata, isSecret) as Record<string, unknown>) : null,
    };
  }
  const requestOrigin = (ctx: Context): Origin => ({ actor: ctx.user?.id ?? null, org: orgOf(ctx), ip: ctx.ip ?? null, userAgent: ctx.headers.get("user-agent"), requestId: ctx.requestId });
  const systemOrigin = (who: SystemActor = {}): Origin => ({ actor: who.actor ?? "system", org: who.org ?? null, ip: null, userAgent: null, requestId: null });

  function write(ctx: Context, entry: AuditEntry): Promise<AuditRecord> {
    return store.append(toInput(entry, requestOrigin(ctx)), ctx.env, appendOpts);
  }

  async function writeMany(entries: AuditEntry[], origin: Origin, env: Env): Promise<AuditRecord[]> {
    if (!Array.isArray(entries)) {
      throw errors.custom({ code: "MIU_E_AUDIT_INVALID", status: 500, message: "Invalid audit entries: expected an array", fix: "Call logMany([{ action, resource, ... }, ...])." });
    }
    const inputs = entries.map((e) => toInput(e, origin));
    if (store.appendMany) return store.appendMany(inputs, env, appendOpts);
    // Stores without appendMany: one append per entry, in order (not atomic).
    const out: AuditRecord[] = [];
    for (const input of inputs) out.push(await store.append(input, env, appendOpts));
    return out;
  }

  const service: AuditService = {
    log: (entry, who) => store.append(toInput(entry, systemOrigin(who)), who?.env ?? processEnv(), appendOpts),
    logMany: (entries, who) => writeMany(entries, systemOrigin(who), who?.env ?? processEnv()),
    query: (q = {}, env) => store.query(q, env ?? processEnv()),
  };

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
      if (!app.hasService("audit")) app.provide("audit", service);
      if (!app.dev && store.kind === "memory") app.log.warn("audit() is using memoryAuditStore() in production; entries are lost on restart. Use dbAuditStore().");
      // On Workers the env only exists per request, so that check waits for the first request.
      if (!app.dev && app.runtime !== "workerd" && !keyed(processEnv())) {
        warnedNoKey = true;
        app.log.warn(`audit() has no HMAC key in production: anyone with database write access can rewrite the log and recompute its hashes. Set ${ENV_KEY} (32+ random characters) or audit({ key }).`);
      }
      if (app.dev || app.runtime !== "workerd") warnedNoKey = true;
    },
    onRequest(ctx) {
      if (!warnedNoKey) {
        warnedNoKey = true;
        if (!keyed(ctx.env)) ctx.log.warn(`audit() has no HMAC key in production: set the ${ENV_KEY} secret (32+ random characters) or audit({ key }).`);
      }
      (ctx as { audit: AuditClient }).audit = {
        log: (entry) => write(ctx, entry),
        logMany: (entries) => writeMany(entries, requestOrigin(ctx), ctx.env),
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
        if (!ok && typeof email === "string") {
          if (!opts.redactFailedLoginEmail) metadata.email = email.trim().toLowerCase().slice(0, 254);
          else {
            // Healthcare/PII mode: a keyed hash still links repeated attempts on one account.
            const salt = emailSalt(ctx.env);
            if (salt) metadata.emailHash = await hashAuditEmail(email.slice(0, 1000), salt);
          }
        }
        await write(ctx, { action, resource: "auth", resourceId: ctx.user?.id ?? null, metadata });
      } catch (err) {
        ctx.log.error("audit: could not record auth event", { err, action });
      }
    },
    inspect() {
      return { store: store.inspect?.() ?? { store: store.kind }, keyed: opts.key !== undefined || storeKeys(store) !== undefined ? true : `from env ${ENV_KEY}`, redactFailedLoginEmail: !!opts.redactFailedLoginEmail, auth: !!opts.auth, permission, redact: (opts.redact ?? []).map(String), path: opts.routes === false ? null : path };
    },
    cloudflare(): CloudflareNeeds {
      return store.cloudflare?.() ?? {};
    },
  });
}
