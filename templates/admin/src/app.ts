/**
 * {{name}}: a MiuJS back-office on Bun + SQLite.  `bun run dev`, then open http://localhost:3000/admin
 *
 * Every admin action is also an MCP tool (POST /mcp) and an OpenAPI operation (GET /openapi.json), so agents and
 * scripts can use it with `Authorization: Bearer $ADMIN_API_TOKEN`.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  Miu, t, auth, sessions, login, logout, hashPassword, verifyPassword, mcp, openapi, secureHeaders, rateLimit,
  isProduction, inspector, timing, devLogger, devErrors, type Repository,
} from "miujs";
import { openDatabase, sqliteRepository, sqliteStore } from "miujs/sqlite";
import { diskBlobStore } from "miujs/node";
import { admin } from "miujs/admin";

export interface AppConfig {
  /** Directory holding the SQLite database and uploaded files. */
  dataDir: string;
  /** The admin account created on first run. Without a password, one is generated and printed once. */
  adminEmail: string;
  adminPassword?: string;
  /** Signs session cookies (32+ characters). Required in production; random (sign-ins end on restart) otherwise. */
  sessionSecret?: string;
  /** Optional bearer token that acts as the admin, for scripts and AI agents (MCP). */
  apiToken?: string;
  /** Request logs and the dev request inspector. Default true. */
  logs?: boolean;
}

export const configFromEnv = (env: Record<string, string | undefined> = process.env): AppConfig => ({
  dataDir: env.DATA_DIR || "data",
  adminEmail: env.ADMIN_EMAIL || "admin@example.com",
  adminPassword: env.ADMIN_PASSWORD || undefined,
  sessionSecret: env.SESSION_SECRET || undefined,
  apiToken: env.ADMIN_API_TOKEN || undefined,
});

// ---------- Schemas: one t.object() per resource (id, createdAt and updatedAt are added for you) ----------

export const Author = t.object({
  name: t.string({ min: 1, max: 120 }),
  email: t.optional(t.string({ format: "email" })),
  bio: t.optional(t.string({ max: 2000 })),
});

export const Post = t.object({
  title: t.string({ min: 1, max: 200 }),
  status: t.default(t.enum(["draft", "published"]), "draft"),
  authorId: t.string({ description: "The post's author" }),
  cover: t.optional(t.string()),
  body: t.optional(t.string({ max: 20_000 })),
  publishedOn: t.optional(t.string({ format: "date" })),
});

interface User { id: string; email: string; name: string; roles: string[]; passwordHash: string }

export async function createApp(config: AppConfig = configFromEnv()) {
  if (!config.sessionSecret && isProduction()) throw new Error("Set SESSION_SECRET (32+ random characters) in production");
  const logs = config.logs !== false;

  // ---------- storage: SQLite for data, sessions and rate limits; local disk for uploads ----------
  mkdirSync(config.dataDir, { recursive: true });
  const db = await openDatabase(join(config.dataDir, "app.sqlite"));
  const store = sqliteStore({ db });
  const files = diskBlobStore({ root: join(config.dataDir, "uploads") });
  const users = sqliteRepository<User>({ db, table: "users", indexes: ["email"] });
  const authors = sqliteRepository<any>({ db, table: "authors", searchFields: ["name", "email"] });
  const posts = sqliteRepository<any>({ db, table: "posts", searchFields: ["title", "body"], indexes: ["authorId", "status"] });
  const audit = sqliteRepository<any>({ db, table: "audit_log", indexes: ["resource"] });
  await seedAdmin(users, config);

  const app = new Miu({ name: "{{name}}", version: "0.1.0", logger: logs });
  // DevTools: request inspector at /__miu, Server-Timing and readable error pages. All three are off unless
  // MIU_ENV=development (the `dev` script sets it); in production devLogger writes JSON lines.
  if (logs) app.use(inspector()).use(devLogger());
  app.use(timing());
  app.onError(devErrors({ log: logs ? undefined : false }));
  app.use(secureHeaders());
  app.use(sessions({ store, secret: config.sessionSecret ?? randomToken(32), cookie: { secure: isProduction() } }));
  app.use(auth<Omit<User, "passwordHash">>({
    loadUser: async (id) => {
      const u = await users.get(id);
      return u && { id: u.id, email: u.email, name: u.name, roles: u.roles };
    },
    bearer: async (token) =>
      config.apiToken && (await sameSecret(token, config.apiToken))
        ? { id: "api", email: "api@localhost", name: "API token", roles: ["admin"] }
        : undefined,
  }));
  app.use(openapi()); // GET  /openapi.json
  app.use(mcp()); //     POST /mcp

  // ---------- sign in / out ----------
  app.get("/login", { tool: false, hidden: true }, (c) => c.html(loginPage(String(c.query.next ?? "/admin"), c.query.error !== undefined), 200, {
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  }));
  app.post("/login", { tool: false, hidden: true, use: [rateLimit({ store, limit: 10, window: 60, prefix: "login:" })] }, async (c) => {
    const site = c.req.headers.get("sec-fetch-site");
    if (site && site !== "same-origin") return c.text("Cross-site sign-in refused", 403);
    const form = await c.req.formData();
    const next = safeNext(c.query.next);
    const u = (await users.list({ where: { email: String(form.get("email") ?? "").trim().toLowerCase() }, limit: 1 })).items[0];
    if (!u || !(await verifyPassword(String(form.get("password") ?? ""), u.passwordHash))) {
      return c.redirect(`/login?error=1&next=${encodeURIComponent(next)}`, 303);
    }
    await login(c, { id: u.id });
    return c.redirect(next, 303);
  });
  app.post("/logout", { tool: false, hidden: true }, async (c) => {
    await logout(c);
    return c.redirect("/login", 303);
  });
  app.get("/", { tool: false, hidden: true }, (c) => c.redirect("/admin"));

  // ---------- the admin: add a resource = schema + repository + one entry here ----------
  app.route("/admin", admin({
    title: "{{name}}",
    loginUrl: "/login",
    audit,
    resources: {
      posts: {
        label: "Posts",
        schema: Post,
        repo: posts,
        files, // where image/file fields are stored
        titleField: "title",
        listFields: ["title", "cover", "status", "authorId", "publishedOn"],
        defaultSort: "-createdAt",
        fields: {
          authorId: { label: "Author", widget: "relation", relation: { resource: "authors", labelField: "name" } },
          cover: { widget: "image", help: "PNG, JPEG, WebP or GIF" },
          body: { widget: "markdown" },
        },
      },
      authors: {
        label: "Authors",
        schema: Author,
        repo: authors,
        titleField: "name",
        defaultSort: "name",
        fields: { bio: { widget: "textarea" } },
      },
    },
  }));

  return app;
}

// ---------- helpers ----------

async function seedAdmin(users: Repository<User>, config: AppConfig) {
  const email = config.adminEmail.trim().toLowerCase();
  if ((await users.list({ where: { email }, limit: 1 })).total) return;
  const password = config.adminPassword ?? randomToken(12);
  await users.create({ email, name: "Admin", roles: ["admin"], passwordHash: await hashPassword(password) });
  console.log(`Created admin user ${email}${config.adminPassword ? "" : ` with password: ${password}  (set ADMIN_PASSWORD to choose one)`}`);
}

function randomToken(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Only same-site paths, so `?next=` cannot redirect to another site. */
function safeNext(next: unknown): string {
  const s = typeof next === "string" ? next : "";
  return s.startsWith("/") && !s.startsWith("//") && !s.startsWith("/\\") ? s : "/admin";
}

/** Compare secrets via SHA-256 digests so the time taken does not reveal the token. */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

function loginPage(next: string, error: boolean): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · {{name}}</title>
<style>body{font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f5f5f7}
form{background:#fff;padding:2rem;border-radius:12px;box-shadow:0 2px 12px #0001;width:min(320px,90vw)}
label{display:block;margin:.8rem 0}input{width:100%;padding:.5rem;box-sizing:border-box}button{padding:.6rem 1.2rem}
.error{color:#b00020}</style>
<form method="post" action="/login?next=${encodeURIComponent(safeNext(next))}">
<h1>Sign in</h1>${error ? `<p class="error" role="alert">Wrong email or password.</p>` : ""}
<label>Email <input name="email" type="email" autocomplete="username" required autofocus></label>
<label>Password <input name="password" type="password" autocomplete="current-password" required></label>
<button>Sign in</button></form></html>`;
}
