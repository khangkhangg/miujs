// The System area: every plugin's manage() sections (status, lists, settings, actions) behind one
// API under `<basePath>/_admin/system`, with permission checks, input validation, audit rows,
// persisted runtime settings and the actions offered as MCP tools.
//
// Permissions (with @miujs/access; checked against the user's global roles, never an org role):
//   system:read                    the overview, and read access to every plugin
//   system.<plugin>:read           one plugin's sections, lists and settings values
//   system.<plugin>:<action>       run one action (actions named read/settings: run.<name>)
//   system.<plugin>:settings       change one plugin's settings
//   system:<verb>                  that verb on every plugin; system:* is full control
// Without @miujs/access: a signed-in user whose roles include "admin".

import { errors, isMiuError, route, t, validate, type App, type Context, type ManageAction, type ManageList, type ManageSection, type Plugin, type RouteDef, type Schema } from "miujs";
import type { Database } from "@miujs/db";
import { redact, redactor, type AuditEntry, type AuditService } from "@miujs/audit";
import { adminErrors } from "./errors.ts";
import { settingsKey, SettingsSync, type SettingsTarget } from "./system-settings.ts";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;
const REDACTED = "[REDACTED]";
const isSecret = redactor();

export interface SystemEntry {
  name: string;
  builtin: boolean;
  plugin: Plugin | null;
  sections: ManageSection[];
}

export interface SystemOptions {
  app(): App;
  base: string;
  builtin(): ManageSection[];
  mcp: boolean;
  now(): number;
  ttlMs: number;
  database(ctx: Context): Promise<Database>;
}

/** `system.<plugin>` as an @miujs/access permission resource (letters, digits, _ . -). */
export const permissionResource = (plugin: string) => `system.${plugin.replace(/[^A-Za-z0-9_.-]/g, "_")}`;
const actionVerb = (name: string) => (name === "read" || name === "settings" ? `run.${name}` : name);
export const actionPermission = (plugin: string, action: string) => `${permissionResource(plugin)}:${actionVerb(action)}`;

const enc = encodeURIComponent;
const toolName = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);

type Can = (permission: string) => boolean;
const canOf = (ctx: Context): Can | null => {
  const c = (ctx as { can?: unknown }).can;
  return typeof c === "function" ? (p: string) => !!(c as Can).call(ctx, p) : null;
};

/** Refuses requests with an active organization when @miujs/access is installed. */
function guard(ctx: Context): void {
  if (canOf(ctx) && (ctx as { org?: unknown }).org) throw adminErrors.systemOrgScoped();
}

/** May this user do `verb` on `plugin` (null: the System area as a whole)? */
export function systemAllowed(ctx: Context, plugin: string | null, verb: string): boolean {
  if (!ctx.user) return false;
  const can = canOf(ctx);
  if (!can) return !!ctx.user.roles?.includes("admin");
  if (plugin === null) return can(`system:${verb}`);
  return can(`${permissionResource(plugin)}:${verb}`) || can(`system:${verb}`);
}

function need(ctx: Context, plugin: string | null, verb: string): void {
  if (systemAllowed(ctx, plugin, verb)) return;
  throw adminErrors.systemForbidden(plugin === null ? `system:${verb}` : `${permissionResource(plugin)}:${verb}`, !!canOf(ctx));
}

const json = (s: Schema | undefined) => (s ? s.json : null);
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

function collect(app: App, builtin: ManageSection[], log: (m: string, d?: Record<string, unknown>) => void): SystemEntry[] {
  const out: SystemEntry[] = [{ name: "app", builtin: true, plugin: null, sections: builtin }];
  const seen = new Set(["app"]);
  for (const p of app.plugins) {
    if (seen.has(p.name)) {
      log(`admin: a second plugin named "${p.name}" is left out of the System area`);
      continue;
    }
    seen.add(p.name);
    let sections: ManageSection[] = [];
    if (typeof p.manage === "function") {
      try {
        sections = (p.manage() ?? []).filter((s) => s && typeof s.id === "string");
      } catch (err) {
        log(`admin: ${p.name}.manage() threw; its sections are left out`, { err });
      }
    }
    out.push({ name: p.name, builtin: false, plugin: p, sections });
  }
  return out;
}

/** The System area of one admin() instance. */
export function createSystem(o: SystemOptions) {
  const { base } = o;
  const app = o.app;
  const log = (m: string, d?: Record<string, unknown>) => app().log.warn(m, d);
  let entries: SystemEntry[] | null = null;
  let byName = new Map<string, SystemEntry>();
  let targets = new Map<string, SettingsTarget>();

  /** Built on first use, after every plugin's setup ran. */
  const registry = () => {
    if (entries) return entries;
    entries = collect(app(), o.builtin(), log);
    byName = new Map(entries.map((e) => [e.name, e]));
    targets = new Map();
    for (const e of entries) for (const s of e.sections) if (s.settings) targets.set(settingsKey(e.name, s.id), { plugin: e.name, section: s.id, settings: s.settings });
    return entries;
  };

  const settings = new SettingsSync({ ttlMs: o.ttlMs, now: o.now, targets: () => (registry(), targets), log });

  const entryOf = (name: string): SystemEntry => {
    registry();
    const e = byName.get(name);
    if (!e) throw adminErrors.systemPluginUnknown(name, [...byName.keys()]);
    return e;
  };
  const sectionOf = (e: SystemEntry, id: string): ManageSection => {
    const s = e.sections.find((x) => x.id === id);
    if (!s) throw adminErrors.systemSectionUnknown(e.name, id, e.sections.map((x) => x.id));
    return s;
  };
  const listOf = (e: SystemEntry, s: ManageSection, name: string): ManageList => {
    const l = s.lists?.find((x) => x.name === name);
    if (!l) throw adminErrors.systemListUnknown(e.name, s.id, name, (s.lists ?? []).map((x) => x.name));
    return l;
  };

  const actionMeta = (ctx: Context, plugin: string, a: ManageAction) => ({
    name: a.name,
    title: a.title,
    description: a.description ?? null,
    danger: !!a.danger,
    input: json(a.input),
    permission: actionPermission(plugin, a.name),
    allowed: systemAllowed(ctx, plugin, actionVerb(a.name)),
  });

  const sectionSummary = (s: ManageSection) => ({
    id: s.id,
    title: s.title,
    description: s.description ?? null,
    status: typeof s.status === "function",
    lists: (s.lists ?? []).map((l) => l.name),
    settings: !!s.settings,
    actions: (s.actions ?? []).map((a) => a.name),
  });

  const cloudflareOf = (p: Plugin | null) => {
    if (!p || typeof p.cloudflare !== "function") return null;
    try {
      return p.cloudflare();
    } catch {
      return null;
    }
  };

  async function audit(ctx: Context, entry: AuditEntry): Promise<void> {
    try {
      const client = (ctx as { audit?: { log?: (e: AuditEntry) => Promise<unknown> } }).audit;
      if (client && typeof client.log === "function") await client.log(entry);
      else if (app().hasService("audit")) await app().service<AuditService>("audit").log(entry, { actor: ctx.user?.id ?? "system", env: ctx.env });
    } catch (err) {
      ctx.log.error("admin: writing the System audit row failed", { err, action: entry.action, resource: entry.resource });
    }
  }

  async function runAction(ctx: Context, plugin: string, sectionId: string, actionName: string, raw: unknown, row: { list: string; id: string } | null, validated: boolean) {
    guard(ctx);
    const e = entryOf(plugin);
    const s = sectionOf(e, sectionId);
    const list = row ? listOf(e, s, row.list) : null;
    const pool = list ? (list.rowActions ?? []) : (s.actions ?? []);
    const a = pool.find((x) => x.name === actionName);
    if (!a) throw adminErrors.systemActionUnknown(e.name, s.id, actionName, pool.map((x) => x.name));
    need(ctx, e.name, actionVerb(a.name));
    let input: unknown;
    if (!a.input) input = {};
    else if (validated) input = raw;
    else {
      const takesId = row !== null && a.input.json.type === "object" && own((a.input.json.properties as object) ?? {}, "id");
      const value = takesId && raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as object), id: row!.id } : raw;
      const checked = validate(a.input, value);
      if (!checked.ok) throw errors.validation("body", checked.issues);
      input = checked.value;
    }
    if (row && input && typeof input === "object" && !Array.isArray(input)) input = { ...(input as object), id: row.id };
    else if (row && (input === undefined || input === null)) input = { id: row.id };
    const metadata: Record<string, unknown> = { plugin: e.name, section: s.id, ...(row ? { list: row.list, id: row.id } : {}), action: a.name, danger: !!a.danger, input: redact(input, isSecret) };
    const entry = { action: "system.action", resource: `system.${e.name}`, resourceId: row ? `${s.id}/${row.list}/${row.id}/${a.name}` : `${s.id}/${a.name}` };
    let result: unknown;
    try {
      result = await a.run(input, ctx);
    } catch (err) {
      await audit(ctx, { ...entry, metadata: { ...metadata, status: "error", error: isMiuError(err) ? err.code : "MIU_E_INTERNAL" } });
      throw err;
    }
    await audit(ctx, { ...entry, metadata: { ...metadata, status: "ok" } });
    return { ok: true, result: result === undefined ? null : result };
  }

  const redactedSettings = (v: unknown) => redact(v, isSecret);

  // ---------------------------------------------------------------------------------- routes

  const tags = ["admin", "system"];
  const common = { tags, auth: "required" as const, mcp: false };
  const pluginParams = t.object({ plugin: t.string({ maxLength: 200 }) });
  const sectionParams = t.object({ plugin: t.string({ maxLength: 200 }), section: t.string({ maxLength: 200 }) });
  const listParams = t.object({ plugin: t.string({ maxLength: 200 }), section: t.string({ maxLength: 200 }), list: t.string({ maxLength: 200 }) });
  const actionParams = t.object({ plugin: t.string({ maxLength: 200 }), section: t.string({ maxLength: 200 }), action: t.string({ maxLength: 200 }) });
  const rowParams = t.object({ plugin: t.string({ maxLength: 200 }), section: t.string({ maxLength: 200 }), list: t.string({ maxLength: 200 }), id: t.string({ minLength: 1, maxLength: 1000 }), action: t.string({ maxLength: 200 }) });
  const anyBody = t.optional(t.unknown());

  const routes: RouteDef[] = [
    route.get(base, {
      ...common,
      name: "system_overview",
      mcp: o.mcp,
      description: "Start here: the plugins you may read, each with its management sections (ids for system_status) and what you may change. Requires system:read or system.<plugin>:read (the admin role without @miujs/access).",
      summary: "List the plugins of this app and their management sections",
      handler: (ctx) => {
        const c = ctx as unknown as Context;
        guard(c);
        const all = registry();
        const visible = all.filter((e) => systemAllowed(c, e.name, "read"));
        if (!visible.length && !systemAllowed(c, null, "read")) need(c, null, "read");
        return {
          app: { name: app().name, version: app().version, runtime: app().runtime, dev: app().dev },
          plugins: visible.map((e) => ({
            name: e.name,
            builtin: e.builtin,
            inspect: !!e.plugin && typeof e.plugin.inspect === "function",
            cloudflare: cloudflareOf(e.plugin),
            sections: e.sections.map(sectionSummary),
            can: { read: true, settings: systemAllowed(c, e.name, "settings") },
          })),
        };
      },
    }),
    route.get(`${base}/:plugin`, {
      ...common,
      name: "admin_system_plugin",
      summary: "One plugin: its management sections and inspect() output (secrets redacted)",
      params: pluginParams,
      handler: (ctx) => {
        const c = ctx as unknown as Context;
        guard(c);
        const e = entryOf(ctx.params.plugin);
        need(c, e.name, "read");
        let inspect: unknown = null;
        if (e.plugin && typeof e.plugin.inspect === "function") {
          try {
            inspect = redact(e.plugin.inspect(), isSecret) ?? null;
          } catch {
            inspect = null;
          }
        }
        return { name: e.name, builtin: e.builtin, cloudflare: cloudflareOf(e.plugin), sections: e.sections.map(sectionSummary), inspect };
      },
    }),
    route.get(`${base}/:plugin/:section`, {
      ...common,
      name: "system_status",
      mcp: o.mcp,
      description: "Status (stats, tables) of one section, plus its lists (for system_list), settings schema and actions (run them with system_<plugin>_<action>). Requires system.<plugin>:read or system:read.",
      summary: "One management section: status, lists, settings schema and actions",
      params: sectionParams,
      handler: async (ctx) => {
        const c = ctx as unknown as Context;
        guard(c);
        const e = entryOf(ctx.params.plugin);
        need(c, e.name, "read");
        const s = sectionOf(e, ctx.params.section);
        let status: unknown = null;
        let statusError: string | null = null;
        if (typeof s.status === "function") {
          try {
            status = await s.status(c);
          } catch (err) {
            c.log.error("admin: a System status() failed", { plugin: e.name, section: s.id, err });
            statusError = isMiuError(err) ? err.message : "Status unavailable";
          }
        }
        return {
          plugin: e.name,
          section: { id: s.id, title: s.title, description: s.description ?? null },
          status,
          statusError,
          lists: (s.lists ?? []).map((l) => ({
            name: l.name,
            title: l.title,
            columns: l.columns,
            idKey: l.idKey,
            searchable: !!l.searchable,
            filters: l.filters ?? [],
            rowActions: (l.rowActions ?? []).map((a) => actionMeta(c, e.name, a)),
          })),
          settings: s.settings ? { schema: s.settings.schema.json, canWrite: systemAllowed(c, e.name, "settings") } : null,
          actions: (s.actions ?? []).map((a) => actionMeta(c, e.name, a)),
        };
      },
    }),
    route.get(`${base}/:plugin/:section/lists/:list`, {
      ...common,
      name: "system_list",
      mcp: o.mcp,
      description: "One page of a section list: { rows, next }. Pass next back as cursor. limit 1-100 (default 25). filters is a JSON object string of the list filter keys to one of their options, e.g. {\"state\":\"failed\"}. Requires system.<plugin>:read or system:read.",
      summary: "One page of a management list",
      params: listParams,
      query: t.object({
        cursor: t.optional(t.string({ maxLength: 4000 })),
        limit: t.optional(t.integer({ min: 1, description: `Page size; capped at ${MAX_LIMIT}` })),
        search: t.optional(t.string({ maxLength: 500 })),
        filters: t.optional(t.string({ maxLength: 4000, description: 'JSON object, e.g. {"state":"failed"}' })),
      }),
      handler: async (ctx) => {
        const c = ctx as unknown as Context;
        guard(c);
        const e = entryOf(ctx.params.plugin);
        need(c, e.name, "read");
        const s = sectionOf(e, ctx.params.section);
        const l = listOf(e, s, ctx.params.list);
        const q = ctx.query;
        if (q.search !== undefined && q.search !== "" && !l.searchable) throw adminErrors.systemSearchUnsupported(l.name);
        let filters: Record<string, string> | undefined;
        if (q.filters !== undefined && q.filters.trim() !== "") {
          let parsed: unknown;
          try {
            parsed = JSON.parse(q.filters);
          } catch {
            throw adminErrors.systemFilterInvalid("not valid JSON");
          }
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw adminErrors.systemFilterInvalid("expected a JSON object");
          filters = {};
          for (const [k, v] of Object.entries(parsed)) {
            if (v === "" || v === null) continue;
            const def = (l.filters ?? []).find((f) => f.key === k);
            if (!def) throw adminErrors.systemFilterInvalid(`unknown filter "${k}"; known: ${(l.filters ?? []).map((f) => f.key).join(", ") || "(none)"}`);
            if (typeof v !== "string" || !def.options.includes(v)) throw adminErrors.systemFilterInvalid(`"${k}" must be one of ${def.options.join(", ")}`);
            filters[k] = v;
          }
          if (!Object.keys(filters).length) filters = undefined;
        }
        const query: { cursor?: string; limit: number; search?: string; filters?: Record<string, string> } = { limit: Math.min(q.limit ?? DEFAULT_LIMIT, MAX_LIMIT) };
        if (q.cursor) query.cursor = q.cursor;
        if (q.search) query.search = q.search;
        if (filters) query.filters = filters;
        const page = await l.list(query, c);
        return { rows: Array.isArray(page?.rows) ? page.rows : [], next: typeof page?.next === "string" && page.next !== "" ? page.next : null };
      },
    }),
    route.post(`${base}/:plugin/:section/actions/:action`, {
      ...common,
      name: "admin_system_action",
      summary: "Run a management action (the body is its input)",
      params: actionParams,
      body: anyBody,
      handler: (ctx) => runAction(ctx as unknown as Context, ctx.params.plugin, ctx.params.section, ctx.params.action, ctx.body, null, false),
    }),
    route.post(`${base}/:plugin/:section/lists/:list/:id/actions/:action`, {
      ...common,
      name: "admin_system_row_action",
      summary: "Run a management action on one list row (the body is its input; the row id is merged in)",
      params: rowParams,
      body: anyBody,
      handler: (ctx) => runAction(ctx as unknown as Context, ctx.params.plugin, ctx.params.section, ctx.params.action, ctx.body, { list: ctx.params.list, id: ctx.params.id }, false),
    }),
    route.get(`${base}/:plugin/:section/settings`, {
      ...common,
      name: "admin_system_settings",
      summary: "A section's runtime settings (secret-looking keys redacted) and their schema",
      params: sectionParams,
      handler: async (ctx) => {
        const c = ctx as unknown as Context;
        guard(c);
        const e = entryOf(ctx.params.plugin);
        need(c, e.name, "read");
        const s = sectionOf(e, ctx.params.section);
        if (!s.settings) throw adminErrors.systemSettingsUnknown(e.name, s.id);
        return { schema: s.settings.schema.json, value: redactedSettings(await s.settings.get(c)), canWrite: systemAllowed(c, e.name, "settings") };
      },
    }),
    route.put(`${base}/:plugin/:section/settings`, {
      ...common,
      name: "admin_system_settings_update",
      summary: "Change a section's runtime settings; saved and applied on every instance",
      params: sectionParams,
      body: anyBody,
      handler: async (ctx) => {
        const c = ctx as unknown as Context;
        guard(c);
        const e = entryOf(ctx.params.plugin);
        const s = sectionOf(e, ctx.params.section);
        if (!s.settings) throw adminErrors.systemSettingsUnknown(e.name, s.id);
        need(c, e.name, "settings");
        const before = await s.settings.get(c);
        let raw = ctx.body;
        // "[REDACTED]" (as GET returns secrets) means "keep the current value".
        if (raw && typeof raw === "object" && !Array.isArray(raw) && before && typeof before === "object") {
          const next: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
          for (const [k, v] of Object.entries(next)) if (v === REDACTED && own(before as object, k)) next[k] = (before as Record<string, unknown>)[k];
          raw = next;
        }
        const checked = validate(s.settings.schema, raw);
        if (!checked.ok) throw errors.validation("body", checked.issues);
        const db = await o.database(c);
        await s.settings.set(checked.value, c);
        await settings.save(db, e.name, s.id, checked.value, c.user?.id ?? null);
        await audit(c, { action: "system.settings", resource: `system.${e.name}`, resourceId: s.id, before, after: checked.value, metadata: { plugin: e.name, section: s.id } });
        return { ok: true, value: redactedSettings(await s.settings.get(c)) };
      },
    }),
  ];

  /**
   * One route per action at its exact path, so each becomes an MCP tool with the action's own
   * input schema and `destructiveHint` from `danger`. They win over the generic `:action` routes
   * for the same URL and run the same code.
   */
  function mcpRoutes(): RouteDef[] {
    if (!o.mcp) return [];
    const snapshot = collect(app(), o.builtin(), () => {});
    const used = new Set(["system_overview", "system_status", "system_list"]);
    const nameFor = (plugin: string, section: string, action: string) => {
      for (const n of [`system_${plugin}_${action}`, `system_${plugin}_${section}_${action}`]) {
        const tn = toolName(n);
        if (!used.has(tn)) {
          used.add(tn);
          return tn;
        }
      }
      let i = 2;
      while (used.has(toolName(`system_${plugin}_${section}_${action}_${i}`))) i++;
      const tn = toolName(`system_${plugin}_${section}_${action}_${i}`);
      used.add(tn);
      return tn;
    };
    const out: RouteDef[] = [];
    for (const e of snapshot) {
      for (const s of e.sections) {
        const describe = (a: ManageAction) =>
          [a.description, `${e.name} › ${s.title}.`, `Requires permission ${actionPermission(e.name, a.name)} (or the admin role without @miujs/access).`, a.danger ? "Destructive: confirm with the user first." : ""].filter(Boolean).join(" ");
        const body = (a: ManageAction) => a.input ?? t.optional(t.object({}));
        const annotations = (a: ManageAction) => ({ readOnlyHint: false, destructiveHint: !!a.danger, idempotentHint: false, openWorldHint: false });
        for (const a of s.actions ?? []) {
          out.push(
            route.post(`${base}/${enc(e.name)}/${enc(s.id)}/actions/${enc(a.name)}`, {
              tags,
              auth: "required",
              name: nameFor(e.name, s.id, a.name),
              summary: a.title,
              description: describe(a),
              body: body(a),
              annotations: annotations(a),
              handler: (ctx) => runAction(ctx as unknown as Context, e.name, s.id, a.name, ctx.body, null, true),
            }),
          );
        }
        for (const l of s.lists ?? []) {
          for (const a of l.rowActions ?? []) {
            // An input that declares `id` itself is validated with the id merged in, by runAction.
            const declaresId = !!a.input && a.input.json.type === "object" && own((a.input.json.properties as object) ?? {}, "id");
            out.push(
              route.post(`${base}/${enc(e.name)}/${enc(s.id)}/lists/${enc(l.name)}/:id/actions/${enc(a.name)}`, {
                tags,
                auth: "required",
                name: nameFor(e.name, s.id, a.name),
                summary: `${a.title} (${l.title})`,
                description: `${describe(a)} \`id\` is the ${l.idKey} of the ${l.title} row.`,
                params: t.object({ id: t.string({ minLength: 1, maxLength: 1000, description: `${l.idKey} of the row` }) }),
                body: declaresId ? anyBody : body(a),
                annotations: annotations(a),
                handler: (ctx) => runAction(ctx as unknown as Context, e.name, s.id, a.name, ctx.body, { list: l.name, id: ctx.params.id }, !declaresId),
              }),
            );
          }
        }
      }
    }
    return out;
  }

  return {
    routes,
    mcpRoutes,
    registry,
    /** Applies stored settings when the TTL has passed. Never throws. */
    sync(ctx: Context): Promise<void> | undefined {
      registry();
      if (!targets.size) return undefined;
      return settings.sync(() => o.database(ctx), ctx);
    },
  };
}

export type SystemArea = ReturnType<typeof createSystem>;
