// bun examples/admin.ts  ->  http://localhost:3000/admin
//
// A complete back-office for two resources (products with a category relation and an image) in ~100 lines:
// SQLite for data and sessions, local disk for images, a seeded admin user, and every admin action also
// available to agents over MCP (POST /mcp with `Authorization: Bearer $ADMIN_API_TOKEN`).
//
//   ADMIN_PASSWORD=...     password for admin@example.com (default: a random one, printed at startup)
//   SESSION_SECRET=...     at least 32 chars (default: random, so sessions end on restart)
//   ADMIN_API_TOKEN=...    optional bearer token for scripts/agents
//   DATA_DIR=./.miu-admin  where the SQLite file and uploads live
import { mkdirSync } from "node:fs";
import { Miu, t, auth, sessions, login, logout, hashPassword, verifyPassword, mcp, openapi, secureHeaders, rateLimit } from "../src/index.ts";
import { openDatabase, sqliteRepository, sqliteStore } from "../src/sqlite.ts";
import { diskBlobStore } from "../src/adapters/node.ts";
import { admin } from "../src/admin/index.ts";

const dir = (process.env.DATA_DIR ?? ".miu-admin").replace(/\/$/, "");
mkdirSync(dir, { recursive: true });
const db = await openDatabase(`${dir}/data.sqlite`);
const store = sqliteStore({ db });
const random = () => Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => b.toString(16).padStart(2, "0")).join("");

// ----- data -----
interface User { id: string; email: string; name: string; roles: string[]; passwordHash: string }
const users = sqliteRepository<User>({ db, table: "users", indexes: ["email"] });
const categories = sqliteRepository<any>({ db, table: "categories", searchFields: ["name"] });
const products = sqliteRepository<any>({ db, table: "products", searchFields: ["name", "description"], indexes: ["categoryId", "status"] });
const audit = sqliteRepository<any>({ db, table: "audit_log", indexes: ["resource"] });

// Seed the admin user once.
const password = process.env.ADMIN_PASSWORD ?? random();
if (!(await users.list({ where: { email: "admin@example.com" }, limit: 1 })).total) {
  await users.create({ email: "admin@example.com", name: "Admin", roles: ["admin"], passwordHash: await hashPassword(password) });
  console.log(`Seeded admin@example.com${process.env.ADMIN_PASSWORD ? "" : ` with password: ${password}`}`);
}

// ----- app -----
const app = new Miu({ name: "shop-admin", version: "0.1.0" });
app.use(secureHeaders());
app.use(sessions({ store, secret: process.env.SESSION_SECRET ?? random() + random(), cookie: { secure: process.env.NODE_ENV === "production" } }));
app.use(auth<Omit<User, "passwordHash">>({
  loadUser: async (id) => {
    const u = await users.get(id);
    return u && { id: u.id, email: u.email, name: u.name, roles: u.roles };
  },
  bearer: async (token) => {
    const expected = process.env.ADMIN_API_TOKEN;
    if (!expected || !(await sameSecret(token, expected))) return undefined;
    return { id: "api", email: "api@example.com", name: "API token", roles: ["admin"] };
  },
}));
app.use(mcp());
app.use(openapi());

// Sign-in page: plain HTML form (no script), protected against login CSRF and brute force.
app.get("/login", { tool: false, hidden: true }, (c) =>
  c.html(
    `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in</title>
<form method="post" action="/login?next=${encodeURIComponent(String(c.query.next ?? "/admin"))}">
<h1>Sign in</h1><p><label>Email <input name="email" type="email" autocomplete="username" required></label></p>
<p><label>Password <input name="password" type="password" autocomplete="current-password" required></label></p>
<button>Sign in</button></form>`,
    200,
    { "content-security-policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'" },
  ),
);
app.post("/login", { tool: false, hidden: true, use: [rateLimit({ store, limit: 10, window: 60, prefix: "login:" })] }, async (c) => {
  const site = c.req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return c.text("Cross-site sign-in refused", 403);
  const form = await c.req.formData();
  const u = (await users.list({ where: { email: String(form.get("email") ?? "") }, limit: 1 })).items[0];
  if (!u || !(await verifyPassword(String(form.get("password") ?? ""), u.passwordHash))) return c.redirect("/login?error=1", 303);
  await login(c, u);
  const next = String(c.query.next ?? "/admin");
  return c.redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/admin", 303);
});
app.post("/logout", { tool: false, hidden: true }, async (c) => {
  await logout(c);
  return c.redirect("/login", 303);
});

// ----- the admin -----
app.route(
  "/admin",
  admin({
    title: "Shop Admin",
    loginUrl: "/login",
    audit,
    resources: {
      products: {
        label: "Products",
        schema: t.object({
          name: t.string({ min: 1, max: 120 }),
          price: t.number({ min: 0, description: "Price in EUR" }),
          status: t.default(t.enum(["draft", "active", "archived"]), "draft"),
          inStock: t.default(t.boolean(), true),
          categoryId: t.optional(t.string()),
          image: t.optional(t.string()),
          description: t.optional(t.string({ max: 5000 })),
          launchedOn: t.optional(t.string({ format: "date" })),
        }),
        repo: products,
        files: diskBlobStore({ root: `${dir}/uploads` }),
        maxFileSize: 10 * 1024 * 1024,
        titleField: "name",
        listFields: ["name", "image", "price", "status", "categoryId"],
        searchFields: ["name", "description"],
        defaultSort: "-createdAt",
        fields: {
          categoryId: { label: "Category", widget: "relation", relation: { resource: "categories", labelField: "name" } },
          image: { widget: "image", help: "PNG, JPEG, WebP or GIF, up to 10 MB" },
          description: { widget: "markdown" },
        },
      },
      categories: {
        label: "Categories",
        schema: t.object({ name: t.string({ min: 1, max: 80 }), slug: t.string({ pattern: "^[a-z0-9-]+$", max: 80 }) }),
        repo: categories,
        titleField: "name",
        defaultSort: "name",
        // Categories in use cannot be deleted.
        permissions: {
          delete: async (user, { doc }) =>
            user.roles.includes("admin") && (!doc || (await products.list({ where: { categoryId: doc.id }, limit: 1 })).total === 0),
        },
      },
    },
  }),
);

app.get("/", { tool: false, hidden: true }, (c) => c.redirect("/admin"));

const server = app.listen(Number(process.env.PORT ?? 3000));
console.log(`Admin on http://localhost:${server.port}/admin (MCP at /mcp, OpenAPI at /openapi.json)`);

/** Compare secrets via their SHA-256 digests so the comparison time does not depend on the token. */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const d = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const [x, y] = await Promise.all([d(a), d(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}
