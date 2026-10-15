// adminUI(): server-rendered admin screens for the admin() resources, plus a visual builder
// for JSON workflows. Every read and write goes through the resource API (sub-requests), so
// the server enforces permissions, tenancy and validation whatever the page shows.

import { definePlugin, errors, route, t, type App, type Context, type RouteDef } from "miujs";
import { html } from "@miujs/web";
import { resolveDatabase, type Database, type DatabaseSource } from "@miujs/db";
import type { ActionDef } from "@miujs/workflows";
import { buildAssets } from "./assets.ts";
import { orgsFor, type AdminLike, type Core, type WorkflowsLike } from "./core.ts";
import { cookieOrg, orgCookie, platformOf, redirect, safeNext, sub } from "./http.ts";
import { barePage, type Shell } from "./layout.ts";
import * as pages from "./pages.ts";
import * as sysPages from "./system-pages.ts";
import * as wfPages from "./workflow-pages.ts";
import { WorkflowLoader, workflowStore, type WorkflowStore } from "./workflow-store.ts";

export interface AdminUIOptions {
  /** Where the UI lives. Default "/admin". */
  path?: string;
  /** Shown in the header and page titles. Default "Admin". */
  title?: string;
  brand?: {
    /** Header text (default: title). */
    name?: string;
    /** Logo URL: a same-site path or https URL. */
    logo?: string;
    /** Accent color, #rgb or #rrggbb. */
    accent?: string;
  };
  /** Only these resources appear in the UI. Default: all the user may read. */
  resources?: string[];
  /** Send signed-out users to your own login page (gets ?next=). Default: a built-in form. */
  loginUrl?: string;
  /** @miujs/auth route prefix for the built-in form. Default "/auth". */
  authPath?: string;
  /** @miujs/access org routes. Default "/orgs". */
  orgsPath?: string;
  /** The visual workflow builder. `false` turns it off. */
  workflows?:
    | false
    | {
        /** Extra workflow actions offered in the builder (crm() actions are found automatically). */
        actions?: ActionDef[];
        /** Where `admin_workflows` lives. Default: the admin() database. */
        database?: DatabaseSource;
        /** How long published versions are trusted before re-reading storage. Default 30s. */
        reloadMs?: number;
      };
  /** Largest file accepted by file fields. Default 25 MB. */
  maxUploadBytes?: number;
}

const PATH = /^(\/[A-Za-z0-9._~-]+)+$/;

function checkOptions(o: AdminUIOptions) {
  const path = o.path ?? "/admin";
  if (!PATH.test(path)) throw errors.config("MIU_E_ADMIN_UI_CONFIG", `Invalid adminUI path ${JSON.stringify(path)}`, 'Use an absolute path without a trailing slash, e.g. "/admin".');
  const accent = o.brand?.accent;
  if (accent !== undefined && !/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(accent)) {
    throw errors.config("MIU_E_ADMIN_UI_CONFIG", `Invalid brand.accent ${JSON.stringify(accent)}`, 'Use a hex color such as "#2557d6".');
  }
  const logo = o.brand?.logo;
  if (logo !== undefined && !(/^\/(?!\/)[^\s"'<>\\]*$/.test(logo) || /^https:\/\/[^\s"'<>\\]+$/.test(logo))) {
    throw errors.config("MIU_E_ADMIN_UI_CONFIG", `Invalid brand.logo ${JSON.stringify(logo)}`, 'Use a same-site path ("/logo.svg") or an https URL.');
  }
  if (o.loginUrl !== undefined && !/^(\/(?!\/)|https:\/\/)/.test(o.loginUrl)) {
    throw errors.config("MIU_E_ADMIN_UI_CONFIG", `Invalid loginUrl ${JSON.stringify(o.loginUrl)}`, 'Use a same-site path ("/login") or an https URL.');
  }
  return path;
}

function isAction(v: unknown): v is ActionDef {
  return typeof v === "object" && v !== null && (v as ActionDef).kind === "miu.workflow.action";
}

/**
 * The admin screens:
 *
 * ```ts
 * miu({ plugins: [session(), auth(), access({ roles }), workflows({ workflows }), crm(), adminUI({ title: "Acme CRM" })] })
 * ```
 */
export function adminUI(opts: AdminUIOptions = {}) {
  const path = checkOptions(opts);
  const assets = buildAssets(opts.brand?.accent);
  const shell: Shell = { path, title: opts.title ?? "Admin", brand: opts.brand, css: assets.css.name, js: assets.js.name };
  let core: Core | null = null;
  const stores = new WeakMap<Database, WorkflowStore>();
  const wfOpts = opts.workflows === false ? null : (opts.workflows ?? {});

  const need = (): Core => {
    if (!core) throw errors.config("MIU_E_ADMIN_UI_NOT_READY", "adminUI() is not set up yet", "Pass adminUI() to miu({ plugins }) together with admin() or crm().");
    return core;
  };

  const loginLocation = (ctx: Context) => {
    const next = encodeURIComponent(ctx.url.pathname + ctx.url.search);
    return `${opts.loginUrl ?? `${path}/login`}?next=${next}`;
  };

  /**
   * GET pages: signed in, and the UI's chosen org applied. Browsers do not send x-org-id on
   * navigation, so when the org comes from the UI cookie (or is not chosen yet) the request is
   * dispatched again with the header, and @miujs/access verifies the membership as usual.
   */
  const pageRoute = (p: string, fn: (c: Core, ctx: Context) => Promise<Response>) =>
    route.get(p, {
      tags: ["admin-ui"],
      mcp: false,
      auth: "optional",
      handler: async (ctx) => {
        const c = ctx as unknown as Context;
        const k = need();
        if (!c.user) return redirect(loginLocation(c));
        if (!c.headers.has("x-org-id") && typeof (c as { can?: unknown }).can === "function") {
          let org = cookieOrg(c);
          let remember = false;
          const active = (c as { org?: { id: string } | null }).org?.id ?? null;
          if (!org && !active) {
            org = (await orgsFor(k, c))[0]?.id ?? null;
            remember = !!org;
          }
          if (org && org !== active) {
            const headers = new Headers(c.req.headers);
            headers.set("x-org-id", org);
            const res = await k.app.dispatch(new Request(c.req.url, { method: "GET", headers }), c.env, platformOf(c));
            if (res.status === 403 && !remember) {
              const body = await res.clone().json().catch(() => null);
              if (body?.error?.code === "MIU_E_ACCESS_NOT_MEMBER") return redirect(c.url.pathname + c.url.search, { "set-cookie": orgCookie(c, null) });
            }
            if (!remember) return res;
            const out = new Response(res.body, res);
            out.headers.append("set-cookie", orgCookie(c, org));
            return out;
          }
        }
        return fn(k, c);
      },
    });

  const postRoute = (p: string, fn: (c: Core, ctx: Context) => Promise<Response>, extra: Record<string, unknown> = {}) =>
    route.post(p, {
      tags: ["admin-ui"],
      mcp: false,
      auth: "optional",
      body: t.optional(t.record(t.unknown())),
      maxBodySize: opts.maxUploadBytes ? opts.maxUploadBytes + 1_000_000 : 26_000_000,
      ...extra,
      handler: async (ctx) => {
        const c = ctx as unknown as Context;
        if (!c.user) return redirect(loginLocation(c));
        return fn(need(), c);
      },
    });

  const jsonRoute = <S>(p: string, body: S, fn: (c: Core, ctx: Context, body: any) => Promise<unknown>) =>
    route.post(p, {
      tags: ["admin-ui"],
      mcp: false,
      auth: "required",
      body: body as any,
      handler: async (ctx) => fn(need(), ctx as unknown as Context, ctx.body) as Promise<Record<string, unknown>>,
    });

  const p = path;
  const routes: RouteDef[] = [
    route.get(`${p}/assets/:file`, {
      tags: ["admin-ui"],
      mcp: false,
      params: t.object({ file: t.string({ maxLength: 100 }) }),
      handler: ({ params }) => {
        const a = params.file === assets.css.name ? assets.css : params.file === assets.js.name ? assets.js : null;
        if (!a) return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
        return new Response(a.body, { headers: { "content-type": a.type, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" } });
      },
    }),
    route.get(`${p}/login`, {
      tags: ["admin-ui"],
      mcp: false,
      auth: "optional",
      handler: (ctx) => {
        const c = ctx as unknown as Context;
        const next = safeNext(c.url.searchParams.get("next"), p);
        if (c.user) return redirect(next);
        if (opts.loginUrl) return redirect(`${opts.loginUrl}?next=${encodeURIComponent(next)}`);
        return loginForm(c, next, null, 200);
      },
    }),
    route.post(`${p}/login`, {
      tags: ["admin-ui", "csrf-always"],
      mcp: false,
      auth: "optional",
      body: t.object({ email: t.optional(t.string({ maxLength: 320 })), password: t.optional(t.string({ maxLength: 1000 })), next: t.optional(t.string({ maxLength: 2000 })) }),
      handler: async (ctx) => {
        const c = ctx as unknown as Context;
        const k = need();
        const next = safeNext(ctx.body.next, p);
        const res = await sub(k.app, c, "POST", `${k.authPath}/login`, { body: { email: ctx.body.email ?? "", password: ctx.body.password ?? "" }, org: null });
        if (!res.ok) return loginForm(c, next, res.status === 429 ? "Too many attempts. Wait a minute and try again." : "That email and password do not match an account.", res.status === 429 ? 429 : 401);
        const headers = new Headers();
        for (const cookie of res.headers.getSetCookie()) headers.append("set-cookie", cookie);
        return redirect(next, headers);
      },
    }),
    postRoute(`${p}/logout`, async (k, c) => {
      const res = await sub(k.app, c, "POST", `${k.authPath}/logout`, { org: null });
      const headers = new Headers();
      for (const cookie of res.headers.getSetCookie()) headers.append("set-cookie", cookie);
      headers.append("set-cookie", orgCookie(c, null));
      return redirect(`${p}/login`, headers);
    }),
    postRoute(`${p}/org`, async (k, c) => {
      const form = (c.body ?? {}) as Record<string, unknown>;
      const id = typeof form.orgId === "string" ? form.orgId : "";
      const orgs = await orgsFor(k, c);
      if (!orgs.some((o) => o.id === id)) {
        return barePage(shell, c, "Not a member", html`<h1>Not a member</h1><p class="alert" role="alert">You are not a member of that organization.</p><p><a href="${p}">Back</a></p>`, 403);
      }
      const s = (c as { session?: { set?(k: string, v: unknown): void } }).session;
      if (s && typeof s.set === "function") s.set("orgId", id);
      return redirect(safeNext(form.next, p), { "set-cookie": orgCookie(c, id) });
    }),
    pageRoute(`${p}`, pages.overview),
    pageRoute(`${p}/r/:resource`, (k, c) => pages.listPage(k, c, c.params.resource)),
    pageRoute(`${p}/r/:resource/export.csv`, (k, c) => pages.exportCsv(k, c, c.params.resource)),
    pageRoute(`${p}/r/:resource/new`, (k, c) => pages.newPage(k, c, c.params.resource)),
    pageRoute(`${p}/r/:resource/import`, (k, c) => pages.importPage(k, c, c.params.resource)),
    pageRoute(`${p}/r/:resource/:id`, (k, c) => pages.recordPage(k, c, c.params.resource, c.params.id)),
    postRoute(`${p}/r/:resource/new`, (k, c) => pages.saveRecord(k, c, c.params.resource, null)),
    postRoute(`${p}/r/:resource/bulk`, (k, c) => pages.bulk(k, c, c.params.resource)),
    postRoute(`${p}/r/:resource/:id`, (k, c) => pages.saveRecord(k, c, c.params.resource, c.params.id)),
    postRoute(`${p}/r/:resource/:id/delete`, (k, c) => pages.deleteRecord(k, c, c.params.resource, c.params.id)),
    postRoute(`${p}/r/:resource/:id/action/:action`, (k, c) => pages.recordAction(k, c, c.params.resource, c.params.id, c.params.action)),
    // The System area: plugins' manage() sections, through the <apiBase>/_admin/system API.
    pageRoute(`${p}/system`, sysPages.overview),
    pageRoute(`${p}/system/:plugin`, (k, c) => sysPages.pluginPage(k, c, c.params.plugin)),
    pageRoute(`${p}/system/:plugin/:section`, (k, c) => sysPages.sectionPage(k, c, c.params.plugin, c.params.section)),
    postRoute(`${p}/system/:plugin/:section/actions/:action`, (k, c) => sysPages.runAction(k, c, c.params.plugin, c.params.section, c.params.action, null)),
    postRoute(`${p}/system/:plugin/:section/lists/:list/:id/actions/:action`, (k, c) =>
      sysPages.runAction(k, c, c.params.plugin, c.params.section, c.params.action, { list: c.params.list, id: c.params.id }),
    ),
    postRoute(`${p}/system/:plugin/:section/settings`, (k, c) => sysPages.saveSettings(k, c, c.params.plugin, c.params.section)),
  ];
  if (wfOpts) {
    routes.push(
      pageRoute(`${p}/workflows`, wfPages.workflowList),
      pageRoute(`${p}/workflows/new`, (k, c) => wfPages.workflowEditor(k, c, null)),
      pageRoute(`${p}/workflows/edit/:name`, (k, c) => wfPages.workflowEditor(k, c, c.params.name)),
      pageRoute(`${p}/workflows/runs/:name`, (k, c) => wfPages.runsPage(k, c, c.params.name)),
      pageRoute(`${p}/workflows/run/:id`, (k, c) => wfPages.runPage(k, c, c.params.id)),
      postRoute(`${p}/workflows/save`, wfPages.saveForm),
      postRoute(`${p}/workflows/publish/:name`, (k, c) => wfPages.publishForm(k, c, c.params.name, false)),
      postRoute(`${p}/workflows/unpublish/:name`, (k, c) => wfPages.publishForm(k, c, c.params.name, true)),
      postRoute(`${p}/workflows/run/:id/cancel`, (k, c) => wfPages.runControl(k, c, c.params.id, "cancel")),
      postRoute(`${p}/workflows/run/:id/retry`, (k, c) => wfPages.runControl(k, c, c.params.id, "retry")),
      jsonRoute(`${p}/api/workflows/validate`, t.object({ spec: t.unknown() }), (k, c, b) => wfPages.apiValidate(k, c, b.spec)),
      jsonRoute(`${p}/api/workflows`, t.object({ spec: t.unknown() }), (k, c, b) => wfPages.apiSave(k, c, b.spec)),
      jsonRoute(`${p}/api/workflows/:name/publish`, t.object({ version: t.integer({ min: 1 }) }), (k, c, b) => wfPages.apiPublish(k, c, c.params.name, b.version)),
      jsonRoute(`${p}/api/workflows/:name/unpublish`, t.optional(t.object({})), (k, c) => wfPages.apiPublish(k, c, c.params.name, null)),
    );
  }

  function loginForm(ctx: Context, next: string, error: string | null, status: number): Response {
    return barePage(
      shell,
      ctx,
      "Sign in",
      html`<h1>Sign in to ${shell.brand?.name ?? shell.title}</h1>${error ? html`<p class="alert" role="alert">${error}</p>` : ""}<form method="post" action="${p}/login" class="panel"><div class="field"><label for="login-email">Email</label><input type="email" id="login-email" name="email" autocomplete="username" required></div><div class="field"><label for="login-password">Password</label><input type="password" id="login-password" name="password" autocomplete="current-password" required></div><input type="hidden" name="next" value="${next}"><button type="submit" class="primary">Sign in</button></form>`,
      status,
    );
  }

  return definePlugin({
    name: "admin-ui",
    routes,
    setup(app: App) {
      const adminPlugin = app.plugins.find((x) => x.name === "admin") as unknown as AdminLike | undefined;
      if (!adminPlugin || typeof adminPlugin.schema !== "function") {
        throw errors.config("MIU_E_ADMIN_UI_NO_ADMIN", "adminUI() needs the admin() (or crm()) plugin", "Add admin({ resources }) or crm() to miu({ plugins }) next to adminUI().");
      }
      const wf = wfOpts ? (app.plugins.find((x) => x.name === "workflows") as unknown as WorkflowsLike | undefined) : undefined;
      const workflowsPlugin = wf && typeof wf.register === "function" && typeof wf.unregister === "function" && typeof wf.onUnknown === "function" ? wf : null;
      const listRoute = workflowsPlugin?.routes.find((r) => (r.config as { name?: string }).name === "listWorkflows");
      const timeline = adminPlugin.routes.find((r) => (r.config as { name?: string }).name === "crm_timeline");
      const apiBase = adminPlugin.schema().basePath;
      const actions = (): ActionDef[] => {
        const out = new Map<string, ActionDef>();
        for (const pl of app.plugins) for (const a of ((pl as { actions?: unknown }).actions as unknown[] | undefined) ?? []) if (isAction(a)) out.set(a.name, a);
        for (const a of wfOpts?.actions ?? []) out.set(a.name, a);
        return [...out.values()];
      };
      let lastDatabase: Database | null = null;
      const storeFor = async (ctx: Context): Promise<WorkflowStore> => {
        let database: Database;
        if (wfOpts?.database) database = resolveDatabase(wfOpts.database, ctx.env);
        else if (typeof adminPlugin.runtime === "function") {
          try {
            database = (await adminPlugin.runtime(ctx)).db as Database;
          } catch (err) {
            // Outside a request (a cron event) there is no ctx.db: use the one seen last.
            if (!lastDatabase) throw err;
            database = lastDatabase;
          }
        } else throw errors.config("MIU_E_ADMIN_UI_DATABASE", "adminUI() has no database for workflows", "Pass adminUI({ workflows: { database } }).");
        lastDatabase = database;
        let s = stores.get(database);
        if (!s) stores.set(database, (s = workflowStore(database)));
        return s;
      };
      const loader = workflowsPlugin
        ? new WorkflowLoader({ target: () => workflowsPlugin, actions, ttlMs: wfOpts?.reloadMs ?? 30_000, log: (m, d) => app.log.warn(m, d as Record<string, unknown>) })
        : null;
      if (workflowsPlugin && loader) {
        // A webhook, cron event or run for a workflow this instance does not know may have been
        // published by another isolate: re-read storage now (throttled), not only every reloadMs.
        workflowsPlugin.onUnknown(async (_what, env) => {
          await loader.refresh(await storeFor({ env } as unknown as Context));
        });
      }
      core = {
        app,
        shell,
        path,
        admin: adminPlugin,
        apiBase,
        only: opts.resources ?? null,
        orgsPath: (opts.orgsPath ?? "/orgs").replace(/\/$/, ""),
        authPath: (opts.authPath ?? "/auth").replace(/\/$/, ""),
        loginUrl: opts.loginUrl ?? null,
        timelinePath: timeline ? timeline.path.replace(/\/:resource\/:id$/, "") : null,
        workflows: workflowsPlugin,
        wfPrefix: listRoute ? listRoute.path : "/workflows",
        store: storeFor,
        loader,
        actions,
        maxUpload: opts.maxUploadBytes ?? 25 * 1024 * 1024,
      };
    },
    async onRequest(ctx: Context) {
      // Published UI workflows must be in the engine before any write emits events.
      const k = core;
      if (!k?.loader || !ctx.route) return;
      try {
        await k.loader.ensure(await k.store(ctx));
      } catch (err) {
        ctx.log.error("admin ui: loading published workflows failed", { err });
      }
    },
    inspect() {
      return {
        path,
        assets: [assets.css.name, assets.js.name],
        resources: opts.resources ?? "all readable",
        workflows: wfOpts ? { builder: `${path}/workflows`, loaded: core?.loader?.loaded() ?? {} } : false,
        routes: routes.map((r) => `${r.method} ${r.path}`),
      };
    },
  });
}
