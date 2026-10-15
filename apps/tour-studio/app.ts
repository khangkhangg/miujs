/**
 * Tour Studio: a production-shaped MiuJS reference app. Creators sign up, upload 360° panoramas, link scenes
 * with hotspots and publish tours; admins get a generated back-office; agents get MCP with API keys.
 *
 *   const { app, close } = await createApp(loadConfig());
 *
 * Storage: one SQLite database (users, tours, scenes, hotspots, audit log, sessions, rate limits, API keys)
 * and a disk blob store for panoramas, both under `config.dataDir`. Swap `sqliteRepository`/`sqliteStore`/
 * `diskBlobStore` for the D1/KV/R2 or Redis drivers to scale out; nothing else keeps state in-process.
 */
import { mkdirSync } from "node:fs";
import {
  Miu, t, validate, HttpError, problem, auth, sessions, login, logout, currentUser, hashPassword, verifyPassword,
  createApiKey, verifyApiKey, mcp, openapi, llms, requestId, logger, secureHeaders, rateLimit, clientIp, timing,
  devErrors, inspector, type Context, type Middleware, type Repository, type Store, type BlobStore,
} from "../../src/index.ts";
import { openDatabase, sqliteRepository, sqliteStore, type SqliteDatabase } from "../../src/sqlite.ts";
import { diskBlobStore } from "../../src/adapters/node.ts";
import { admin, type AuditEntry } from "../../src/admin/index.ts";
import { tourKit, csrfGuard, TourSchema, SceneSchema, type Tour, type Scene, type Hotspot } from "../../src/tour/index.ts";
import type { Config } from "./config.ts";
import { accountPage, landing, loginForm, page, signupForm, type Viewer } from "./pages.ts";

export interface User {
  id: string;
  email: string;
  name: string;
  roles: string[];
  passwordHash: string;
  createdAt?: string;
  updatedAt?: string;
}
export type PublicUser = Omit<User, "passwordHash">;

export interface Data {
  db: SqliteDatabase;
  store: Store;
  users: Repository<User>;
  tours: Repository<Tour>;
  scenes: Repository<Scene>;
  hotspots: Repository<Hotspot>;
  audit: Repository<AuditEntry & { id: string }>;
  files: BlobStore;
}

export interface TourStudio {
  app: Miu;
  data: Data;
  config: Config;
  close: () => Promise<void>;
}

const Email = t.string({ format: "email", max: 254, description: "Email address" });
const LoginBody = t.object({ email: Email, password: t.string({ min: 1, max: 200 }) });
const SignupBody = t.object({
  name: t.string({ min: 1, max: 80, description: "Display name" }),
  email: Email,
  password: t.string({ min: 8, max: 200, description: "At least 8 characters" }),
});
const PublicUserSchema = t.object({ id: t.string(), email: t.string(), name: t.string(), roles: t.array(t.string()) });

/** Open (and create) the database and blob store under `dataDir`. */
export async function openData(dataDir: string, opts: { synchronous?: "FULL" | "NORMAL" } = {}): Promise<Data> {
  mkdirSync(dataDir, { recursive: true });
  const db = await openDatabase(`${dataDir}/app.sqlite`);
  // openDatabase() enables WAL but keeps SQLite's default synchronous=FULL (an fsync per commit); NORMAL is the
  // usual WAL setting (durable across app crashes, may lose the last commits on power loss). Opt-in here.
  if (opts.synchronous) db.exec(`PRAGMA synchronous = ${opts.synchronous}`);
  return {
    db,
    store: sqliteStore({ db }),
    users: sqliteRepository<User>({ db, table: "users", indexes: ["email"], searchFields: ["email", "name"] }),
    tours: sqliteRepository<Tour>({ db, table: "tours", indexes: ["slug", "ownerId", "status"], searchFields: ["title", "slug", "description"] }),
    scenes: sqliteRepository<Scene>({ db, table: "scenes", indexes: ["tourId"], searchFields: ["title"] }),
    hotspots: sqliteRepository<Hotspot>({ db, table: "hotspots", indexes: ["tourId", "sceneId"] }),
    audit: sqliteRepository<AuditEntry & { id: string }>({ db, table: "audit_log", indexes: ["resource", "recordId"] }),
    files: diskBlobStore({ root: `${dataDir}/panoramas` }),
  };
}

const publicUser = (u: User): PublicUser => {
  const { passwordHash: _p, ...rest } = u;
  return rest;
};

/** A hash to verify against when the email is unknown, so timing does not reveal which emails exist. */
let dummyHash: Promise<string> | undefined;

export async function findUserByEmail(users: Repository<User>, email: string): Promise<User | undefined> {
  return (await users.list({ where: { email: email.trim().toLowerCase() }, limit: 1 })).items[0];
}

export async function createApp(config: Config, data?: Data): Promise<TourStudio> {
  const d = data ?? (await openData(config.dataDir, { synchronous: config.sqliteSynchronous }));
  const { users, tours, scenes, hotspots, audit, files, store } = d;

  const app = new Miu({
    name: "tour-studio",
    version: "1.0.0",
    description: "Build and publish 360° virtual tours: upload panoramas, link scenes with hotspots, publish.",
    logger: true, // print unexpected 500s (the access log only has the status)
  });

  // ---------- cross-cutting middleware (order matters: inspector first, then timing) ----------
  if (config.dev) {
    app.use(inspector({ token: config.inspectorToken }));
    app.use(timing());
    app.onError(devErrors());
  }
  app.use(requestId());
  if (config.logRequests) app.use(logger({ format: "json" }));
  app.use(secureHeaders());
  app.use(sessions({ store, secret: config.sessionSecret, cookie: { secure: config.secureCookies } }));
  app.use(
    auth<PublicUser>({
      loadUser: async (id) => {
        const u = await users.get(id);
        return u && publicUser(u);
      },
      bearer: async (token) => {
        const key = await verifyApiKey(store, token);
        if (!key) return undefined;
        const u = await users.get(key.userId);
        return u && publicUser(u);
      },
    }),
  );
  app.use(mcp({ instructions: "Tour Studio. Build a 360° tour: tour_create, then scene_import for each panorama (base64), hotspot_create to link scenes, then tour_publish. Public page: /t/<slug>." }));
  app.use(openapi());
  app.use(llms({ intro: "Agents: use the MCP endpoint with `Authorization: Bearer <API key>` (create one at /account)." }));

  // ---------- helpers ----------
  const viewer = (c: Context<any, any>): Viewer | undefined => currentUser<PublicUser>(c);
  const wantsJson = (c: Context<any, any>) =>
    (c.req.headers.get("content-type") ?? "").includes("json") ||
    ((c.req.headers.get("accept") ?? "").includes("application/json") && !(c.req.headers.get("accept") ?? "").includes("text/html"));
  const safeNext = (v: unknown, fallback = "/editor") => {
    const s = typeof v === "string" ? v : "";
    return s.startsWith("/") && !s.startsWith("//") && !s.startsWith("/\\") ? s : fallback;
  };

  /**
   * CSRF for plain HTML form posts (no script, so no custom header): the browser-set `Sec-Fetch-Site` must be
   * same-origin (or absent with a matching `Origin`). Bearer-authenticated calls are exempt.
   */
  const sameOrigin: Middleware = (c, next) => {
    const h = c.req.headers;
    if (h.has("authorization")) return next();
    const site = h.get("sec-fetch-site");
    const origin = h.get("origin");
    if (site && site !== "same-origin" && site !== "none") return problem(403, { code: "csrf", detail: `Cross-site request refused (Sec-Fetch-Site: ${site})` });
    if (!site && origin && origin !== c.url.origin) return problem(403, { code: "csrf", detail: "Cross-origin request refused" });
    return next();
  };

  /** Parse a JSON or form body once (stored on the context) so the rate limiter can key on the email. */
  const readCredentials: Middleware = async (c, next) => {
    const type = c.req.headers.get("content-type") ?? "";
    let body: Record<string, unknown> = {};
    try {
      if (type.includes("json")) body = ((await c.req.json()) ?? {}) as Record<string, unknown>;
      else if (type.includes("form")) body = Object.fromEntries((await c.req.formData()) as unknown as Iterable<[string, string]>);
      else return problem(415, { detail: "Send JSON or an HTML form" });
    } catch {
      return problem(400, { code: "invalid_body", detail: "Malformed request body" });
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) body = {};
    if (typeof body.email === "string") body.email = body.email.trim().toLowerCase();
    c.set("credentials", body);
    return next();
  };
  const credentials = (c: Context<any, any>) => c.get("credentials") as Record<string, unknown>;

  // Behind a trusted proxy key on the client IP; otherwise every client looks the same to a Web-standard
  // handler, so key on the submitted email (stops password guessing per account without one shared bucket).
  const limiter = (prefix: string, limit: number) =>
    rateLimit({
      store, limit, window: 60, prefix,
      key: (c) => `${config.trustProxy ? clientIp(c) : "-"}|${String(credentials(c)?.email ?? "")}`,
    });

  const requireUser = (redirect: boolean): Middleware => (c, next) => {
    if (viewer(c)) return next();
    if (redirect && (c.req.headers.get("accept") ?? "").includes("text/html")) {
      return c.redirect(`/login?next=${encodeURIComponent(c.url.pathname + c.url.search)}`);
    }
    return problem(401, { code: "unauthenticated", detail: "Sign in or send `Authorization: Bearer <API key>`." }, { "www-authenticate": "Bearer" });
  };

  // ---------- pages ----------
  app.get("/", { tool: false, hidden: true }, async (c) => {
    const published = await tours.list({ where: { status: "published" }, sort: "-createdAt", limit: 50 });
    return page(c, { title: "Tour Studio", body: landing(published.items), user: viewer(c) });
  });

  app.get("/healthz", { tool: false, summary: "Liveness check" }, () => ({ ok: true }));

  app.get(
    "/api/tours/published",
    {
      summary: "List published tours",
      description: "Public: the published tours (title, slug, description), newest first. Open one at /t/<slug>.",
      tags: ["public"],
      operationId: "published_tours",
      query: t.object({ limit: t.optional(t.integer({ min: 1, max: 100 })), offset: t.optional(t.integer({ min: 0 })) }),
    },
    async (c) => {
      const r = await tours.list({ where: { status: "published" }, sort: "-createdAt", limit: c.query.limit ?? 20, offset: c.query.offset });
      return { items: r.items.map(({ id, title, slug, description }) => ({ id, title, slug, ...(description ? { description } : {}) })), total: r.total };
    },
  );

  // ---------- accounts ----------
  app.get("/signup", { tool: false, hidden: true }, (c) =>
    viewer(c) ? c.redirect("/editor") : page(c, { title: "Sign up · Tour Studio", body: signupForm() }),
  );

  app.post("/signup", { tool: false, hidden: true, use: [sameOrigin, readCredentials, limiter("signup:", config.authRateLimit)] }, async (c) => {
    const json = wantsJson(c);
    const raw = credentials(c);
    const v = validate(SignupBody, raw);
    if (!v.ok) {
      const msg = v.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      return json
        ? problem(422, { code: "validation_failed", detail: msg, issues: v.issues.map((i) => ({ path: ["body", ...i.path], message: i.message })) })
        : page(c, { title: "Sign up · Tour Studio", body: signupForm(`Please check the form — ${msg}`, raw as never), status: 422 });
    }
    const { name, email, password } = v.value;
    if (await findUserByEmail(users, email)) {
      return json
        ? problem(409, { code: "email_taken", detail: "An account with this email already exists" })
        : page(c, { title: "Sign up · Tour Studio", body: signupForm("An account with this email already exists. Log in instead?", { name, email }), status: 409 });
    }
    const user = await users.create({ email, name, roles: ["creator"], passwordHash: await hashPassword(password) });
    await login(c, user);
    return json ? c.json({ user: publicUser(user) }, 201) : c.redirect("/editor", 303);
  });

  app.get("/login", { tool: false, hidden: true }, (c) => {
    const next = safeNext(c.query.next);
    if (viewer(c)) return c.redirect(next);
    return page(c, { title: "Log in · Tour Studio", body: loginForm(next, c.query.error ? "Wrong email or password." : undefined) });
  });

  app.post("/login", { tool: false, hidden: true, use: [sameOrigin, readCredentials, limiter("login:", config.authRateLimit)] }, async (c) => {
    const json = wantsJson(c);
    const next = safeNext(c.query.next);
    const v = validate(LoginBody, credentials(c));
    let user: User | undefined;
    if (v.ok) {
      user = await findUserByEmail(users, v.value.email);
      const ok = await verifyPassword(v.value.password, user?.passwordHash ?? (await (dummyHash ??= hashPassword("dummy-password"))));
      if (!ok) user = undefined;
    }
    if (!user) {
      return json
        ? problem(401, { code: "invalid_credentials", detail: "Wrong email or password" })
        : c.redirect(`/login?error=1&next=${encodeURIComponent(next)}`, 303);
    }
    await login(c, user);
    return json ? c.json({ user: publicUser(user) }) : c.redirect(next, 303);
  });

  app.post("/logout", { tool: false, hidden: true, use: [sameOrigin] }, async (c) => {
    await logout(c);
    return wantsJson(c) ? c.json({ ok: true }) : c.redirect("/", 303);
  });

  app.get(
    "/api/me",
    { summary: "Who am I", description: "The signed-in user (session cookie or API key): id, email, name, roles.", operationId: "whoami", tags: ["account"], response: PublicUserSchema, use: [requireUser(false)] },
    (c) => {
      const u = currentUser<PublicUser>(c)!;
      return { id: u.id, email: u.email, name: u.name, roles: u.roles };
    },
  );

  // API keys: minted only from a signed-in browser session (an agent's key cannot mint more keys).
  const mintKey = async (c: Context<any, any>, name: string | undefined) => {
    if (c.req.headers.has("authorization")) throw new HttpError(403, "API keys can only be created from a signed-in session", { code: "session_required" });
    const u = currentUser<PublicUser>(c)!;
    return createApiKey(store, { userId: u.id, name: name || "agent", scopes: ["tours"] });
  };

  app.post(
    "/api/keys",
    {
      tool: false, tags: ["account"], summary: "Create an API key",
      description: "Create an API key for agents (shown once). Requires a session cookie; send it as `Authorization: Bearer <key>` to /mcp or the REST API.",
      body: t.object({ name: t.optional(t.string({ max: 80 })) }),
      use: [csrfGuard(), requireUser(false)],
    },
    async (c) => c.json(await mintKey(c, c.body?.name), 201),
  );

  app.get("/account", { tool: false, hidden: true, use: [requireUser(true)] }, async (c) => {
    const u = (await users.get(currentUser<PublicUser>(c)!.id))!;
    return page(c, { title: "Account · Tour Studio", body: accountPage(u), user: viewer(c) });
  });

  app.post("/account/keys", { tool: false, hidden: true, use: [sameOrigin, requireUser(true)] }, async (c) => {
    const form = await c.req.formData().catch(() => undefined);
    const name = String(form?.get("name") ?? "").slice(0, 80);
    const created = await mintKey(c, name);
    const u = (await users.get(currentUser<PublicUser>(c)!.id))!;
    return page(c, { title: "Account · Tour Studio", body: accountPage(u, { key: created.key, name }), user: viewer(c) });
  });

  // ---------- the tour kit (creator API, public API, viewer + editor pages) ----------
  app.route("/", tourKit({ tours, scenes, hotspots, files, loginPath: "/login" }));

  // ---------- admin back-office ----------
  const readOnly = { create: [] as string[], update: [] as string[], delete: [] as string[] };
  app.route(
    "/admin",
    admin({
      title: "Tour Studio Admin",
      loginUrl: "/login",
      audit,
      resources: {
        users: {
          label: "Users",
          repo: users,
          schema: t.object({
            email: Email,
            name: t.string({ min: 1, max: 80 }),
            roles: t.default(t.array(t.enum(["creator", "admin"] as const)), ["creator"]),
            passwordHash: t.optional(t.string()),
          }),
          titleField: "email",
          listFields: ["email", "name", "roles"],
          searchFields: ["email", "name"],
          defaultSort: "-createdAt",
          fields: { passwordHash: { hidden: true } },
          permissions: { delete: [] }, // deactivate instead; creators own tours
        },
        tours: {
          label: "Tours",
          repo: tours,
          schema: TourSchema,
          titleField: "title",
          listFields: ["title", "slug", "status", "ownerId"],
          searchFields: ["title", "slug", "description"],
          defaultSort: "-createdAt",
          fields: {
            ownerId: { label: "Owner", widget: "relation", relation: { resource: "users", labelField: "email" } },
            description: { widget: "textarea" },
            startSceneId: { readOnly: true },
            coverKey: { readOnly: true },
          },
          hooks: {
            // Same cascade as the creator API's delete: scenes, hotspots and stored panoramas go with the tour.
            afterChange: async (e) => {
              if (e.action !== "delete" || !e.before) return;
              const id = e.before.id;
              for (const h of (await hotspots.list({ where: { tourId: id }, limit: 1000 })).items) await hotspots.delete(h.id);
              for (const s of (await scenes.list({ where: { tourId: id }, limit: 1000 })).items) await scenes.delete(s.id);
              for (const b of (await files.list(`tours/${id}/`)).items) await files.delete(b.key);
            },
          },
        },
        scenes: {
          label: "Scenes",
          repo: scenes,
          schema: SceneSchema,
          titleField: "title",
          listFields: ["title", "tourId", "order", "width"],
          defaultSort: "-createdAt",
          fields: {
            tourId: { label: "Tour", widget: "relation", relation: { resource: "tours", labelField: "title" }, readOnly: true },
            panoramaKey: { readOnly: true },
            width: { readOnly: true },
            height: { readOnly: true },
          },
          permissions: { create: [] }, // scenes are created by uploading a panorama in the editor
        },
        audit: {
          label: "Audit log",
          repo: audit,
          schema: t.object({
            at: t.string(),
            user: t.string(),
            action: t.enum(["create", "update", "delete", "upload"] as const),
            resource: t.string(),
            recordId: t.string(),
            changes: t.optional(t.any()),
          }),
          titleField: "recordId",
          listFields: ["at", "user", "action", "resource", "recordId"],
          defaultSort: "-at",
          permissions: readOnly,
        },
      },
    }),
  );

  // Friendly 404 page for browsers; problem+json for everyone else.
  app.notFound((c) =>
    (c.req.headers.get("accept") ?? "").includes("text/html")
      ? page(c, { title: "Not found · Tour Studio", body: `<h1>Not found</h1><p>There is nothing at this address. <a href="/">Back to the tours</a></p>`, user: viewer(c), status: 404 })
      : problem(404, { detail: `No route for ${c.method} ${c.url.pathname}` }),
  );

  return {
    app,
    data: d,
    config,
    close: async () => {
      d.db.close();
    },
  };
}
