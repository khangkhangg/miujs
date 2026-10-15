/**
 * {{name}}: a MiuJS virtual-tour site on Bun + SQLite.  `bun run dev`, then open http://localhost:3000
 *
 *   /                 published tours            /signup, /login   creator accounts
 *   /editor           your tours: upload 2:1 panoramas, place hotspots, publish
 *   /t/<slug>         the public viewer          /mcp, /openapi.json   every creator action as an agent tool
// {{#admin}}
 *   /admin            back-office for tours, scenes and users (role "admin")
// {{/admin}}
 */
import {
  Miu, auth, sessions, login, logout, verifyPassword, currentUser, mcp, openapi, secureHeaders, rateLimit,
  isProduction, inspector, timing, devLogger, devErrors, type Context,
} from "miujs";
import { tourKit } from "miujs/tour";
import { createUser, findUser, openData, randomToken, type Data, type User } from "./data.ts";
import { authPage, landingPage, PAGE_CSP, type Viewer } from "./pages.ts";
// {{#admin}}
import { backOffice, seedAdmin } from "./admin.ts";
// {{/admin}}

export interface AppConfig {
  /** Directory holding the SQLite database and uploaded panoramas. */
  dataDir: string;
  /** Signs session cookies (32+ characters). Required in production; random (sign-ins end on restart) otherwise. */
  sessionSecret?: string;
  /** Request logs and the dev request inspector. Default true. */
  logs?: boolean;
  // {{#admin}}
  /** The admin account created on first run. Without a password, one is generated and printed once. */
  adminEmail: string;
  adminPassword?: string;
  // {{/admin}}
}

export const configFromEnv = (env: Record<string, string | undefined> = process.env): AppConfig => ({
  dataDir: env.DATA_DIR || "data",
  sessionSecret: env.SESSION_SECRET || undefined,
  // {{#admin}}
  adminEmail: env.ADMIN_EMAIL || "admin@example.com",
  adminPassword: env.ADMIN_PASSWORD || undefined,
  // {{/admin}}
});

type PublicUser = Omit<User, "passwordHash">;

export async function createApp(config: AppConfig = configFromEnv(), existing?: Data) {
  if (!config.sessionSecret && isProduction()) throw new Error("Set SESSION_SECRET (32+ random characters) in production");
  const logs = config.logs !== false;
  const data = existing ?? (await openData(config.dataDir));
  const { store, users, tours, scenes, hotspots, files } = data;
  // {{#admin}}
  await seedAdmin(data, config.adminEmail, config.adminPassword);
  // {{/admin}}

  const app = new Miu({ name: "{{name}}", version: "0.1.0", logger: logs });
  // DevTools: request inspector at /__miu, Server-Timing and readable error pages, only with MIU_ENV=development.
  if (logs) app.use(inspector()).use(devLogger());
  app.use(timing());
  app.onError(devErrors({ log: logs ? undefined : false }));
  app.use(secureHeaders());
  app.use(sessions({ store, secret: config.sessionSecret ?? randomToken(32), cookie: { secure: isProduction() } }));
  app.use(auth<PublicUser>({
    loadUser: async (id) => {
      const u = await users.get(id);
      return u && { id: u.id, email: u.email, name: u.name, roles: u.roles };
    },
  }));
  app.use(openapi()); // GET  /openapi.json
  app.use(mcp()); //     POST /mcp

  // The tour kit: creator API (/api/...), editor (/editor), viewer (/t/:slug) and panorama media (/media/...).
  app.route("/", tourKit({ tours, scenes, hotspots, files, loginPath: "/login" }));
  // {{#admin}}
  app.route("/admin", backOffice(data));
  // {{/admin}}

  // ---------- landing page ----------
  const viewerOf = (c: Context<any, any>): Viewer | undefined => {
    const u = currentUser<PublicUser>(c);
    return u ? { name: u.name, isAdmin: u.roles.includes("admin") } : undefined;
  };
  app.get("/", { tool: false, hidden: true }, async (c) => {
    const published = await tours.list({ where: { status: "published" }, sort: "-updatedAt", limit: 60 });
    const items = await Promise.all(published.items.map(async (tour) => {
      const key = tour.coverKey ?? (tour.startSceneId ? (await scenes.get(tour.startSceneId))?.panoramaKey : undefined);
      return { tour, coverUrl: key && `/media/${key}` };
    }));
    return c.html(landingPage(items, viewerOf(c)), 200, { "content-security-policy": PAGE_CSP });
  });

  // ---------- accounts: sign up, log in, log out ----------
  const limit = (prefix: string) => rateLimit({ store, limit: 10, window: 60, prefix });
  const page = (c: Context<any, any>, html: string, status = 200) =>
    c.html(html, status, { "content-security-policy": PAGE_CSP, "cache-control": "no-store" });
  /** Browsers send Sec-Fetch-Site; refuse cross-site form posts (login CSRF). */
  const crossSite = (c: Context<any, any>) => {
    const site = c.req.headers.get("sec-fetch-site");
    return !!site && site !== "same-origin";
  };

  app.get("/signup", { tool: false, hidden: true }, (c) => page(c, authPage("signup", { next: safeNext(c.query.next) })));
  app.post("/signup", { tool: false, hidden: true, use: [limit("signup:")] }, async (c) => {
    if (crossSite(c)) return c.text("Cross-site request refused", 403);
    const form = await c.req.formData();
    const next = safeNext(c.query.next);
    const name = String(form.get("name") ?? "").trim();
    const email = String(form.get("email") ?? "").trim().toLowerCase();
    const password = String(form.get("password") ?? "");
    const error = !name || name.length > 80 ? "Please enter your name (up to 80 characters)."
      : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 ? "Please enter a valid email address."
      : password.length < 8 || password.length > 200 ? "Passwords need at least 8 characters."
      : (await findUser(data, email)) ? "An account with this email already exists. Log in instead."
      : undefined;
    if (error) return page(c, authPage("signup", { next, error }), 422);
    const user = await createUser(data, { email, name, password });
    await login(c, { id: user.id });
    return c.redirect(next, 303);
  });

  app.get("/login", { tool: false, hidden: true }, (c) => page(c, authPage("login", { next: safeNext(c.query.next) })));
  app.post("/login", { tool: false, hidden: true, use: [limit("login:")] }, async (c) => {
    if (crossSite(c)) return c.text("Cross-site request refused", 403);
    const form = await c.req.formData();
    const next = safeNext(c.query.next);
    const user = await findUser(data, String(form.get("email") ?? ""));
    if (!user || !(await verifyPassword(String(form.get("password") ?? ""), user.passwordHash))) {
      return page(c, authPage("login", { next, error: "Wrong email or password." }), 401);
    }
    await login(c, { id: user.id });
    return c.redirect(next, 303);
  });

  app.post("/logout", { tool: false, hidden: true }, async (c) => {
    if (crossSite(c)) return c.text("Cross-site request refused", 403);
    await logout(c);
    return c.redirect("/", 303);
  });

  return app;
}

/** Only same-site paths, so `?next=` cannot redirect to another site. */
function safeNext(next: unknown): string {
  const s = typeof next === "string" ? next : "";
  return s.startsWith("/") && !s.startsWith("//") && !s.startsWith("/\\") ? s : "/editor";
}
