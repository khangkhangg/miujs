import { Miu } from "../../src/core/app.ts";
import { sessions } from "../../src/batteries/session.ts";
import { memoryStore } from "../../src/batteries/store/index.ts";
import { auth, login } from "../../src/batteries/auth/index.ts";
import { memoryRepository, type Repository } from "../../src/batteries/data/index.ts";
import { memoryBlobStore, type BlobStore } from "../../src/batteries/files/index.ts";
import { t } from "../../src/core/schema.ts";
import { mcp } from "../../src/ai/mcp.ts";
import { admin, type AdminOptions, type AuditEntry } from "../../src/admin/index.ts";

export interface TestUser { id: string; name: string; roles: string[] }

export const USERS: Record<string, TestUser> = {
  admin: { id: "u1", name: "Ada", roles: ["admin"] },
  editor: { id: "u2", name: "Eddie", roles: ["editor"] },
  viewer: { id: "u3", name: "Vee", roles: [] },
};
const TOKENS: Record<string, TestUser> = { "tok-admin": USERS.admin!, "tok-editor": USERS.editor!, "tok-viewer": USERS.viewer! };

export const tourSchema = t.object({
  title: t.string({ min: 1, max: 120 }),
  slug: t.optional(t.string({ pattern: "^[a-z0-9-]+$" })),
  status: t.default(t.enum(["draft", "published"]), "draft"),
  rating: t.optional(t.number({ min: 0, max: 5 })),
  featured: t.default(t.boolean(), false),
  body: t.optional(t.string()),
  publishedOn: t.optional(t.string({ format: "date" })),
  categoryId: t.optional(t.string()),
  cover: t.optional(t.string()),
  attachment: t.optional(t.string()),
  views: t.default(t.integer(), 0),
  secret: t.optional(t.string()),
});

export const categorySchema = t.object({ name: t.string({ min: 1 }) });

export function makeApp(extra: Partial<AdminOptions> = {}, resourceExtra: Record<string, unknown> = {}) {
  const store = memoryStore();
  const tours = memoryRepository<any>({ searchFields: ["title", "body"] });
  const categories = memoryRepository<any>();
  const audit = memoryRepository<AuditEntry & { id: string }>();
  const files: BlobStore = memoryBlobStore();
  const app = new Miu({ logger: false });
  app.use(sessions({ store, secret: "s".repeat(32) }));
  app.use(auth<TestUser>({
    loadUser: async (id) => Object.values(USERS).find((u) => u.id === id),
    bearer: async (tok) => TOKENS[tok],
  }));
  // Test-only sign-in: `?as=<user>` (API tests) or a form field `user` (browser test, redirects to `next`).
  app.get("/signin", (c) =>
    c.html(`<!doctype html><title>Sign in</title><form method="post" action="/login?next=${encodeURIComponent(String(c.query.next ?? "/admin"))}">
      <label for="user">User</label><input id="user" name="user"><button type="submit">Sign in</button></form>`),
  );
  app.post("/login", async (c) => {
    const form = (c.req.headers.get("content-type") ?? "").includes("form") ? await c.req.formData() : undefined;
    const u = USERS[String(form?.get("user") ?? c.query.as)];
    if (!u) return new Response("no", { status: 400 });
    await login(c, u);
    const next = String(c.query.next ?? "");
    return form ? c.redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/admin", 303) : { ok: true };
  });
  app.use(mcp());
  app.route("/admin", admin({
    audit: audit as unknown as Repository<any>,
    resources: {
      tours: {
        schema: tourSchema,
        repo: tours,
        label: "Tours",
        titleField: "title",
        listFields: ["title", "status", "featured"],
        defaultSort: "-createdAt",
        files,
        maxFileSize: 1024,
        fields: {
          body: { widget: "markdown" },
          categoryId: { widget: "relation", relation: { resource: "categories", labelField: "name" } },
          cover: { widget: "image" },
          attachment: { widget: "file" },
          views: { readOnly: true },
          secret: { hidden: true },
        },
        ...resourceExtra,
      },
      categories: {
        schema: categorySchema,
        repo: categories,
        permissions: { list: ["admin", "editor"], read: ["admin", "editor"], create: (u: any) => u.id === "u2" || u.roles.includes("admin") },
      },
    },
    ...extra,
  }));
  return { app, tours, categories, audit, files };
}

type App = ReturnType<typeof makeApp>["app"];

/** Log in as a user and return a client that sends the session cookie, CSRF token and same-origin Origin. */
export async function client(app: App, as: string) {
  const res = await app.request(`/login?as=${as}`, { method: "POST" });
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const tokenRes = await app.request("/admin/api/_csrf", { headers: { cookie } });
  const token = tokenRes.ok ? ((await tokenRes.json()) as { token: string }).token : "";
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method,
      headers: {
        cookie,
        ...(method !== "GET" ? { "x-csrf-token": token, origin: "http://localhost" } : {}),
        ...(body !== undefined && !(body instanceof FormData) ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
  return { cookie, token, call };
}

/** Minimal PNG header (signature + IHDR) that `imageInfo` recognizes. */
export function png(width = 4, height = 2): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const dv = new DataView(b.buffer);
  dv.setUint32(16, width);
  dv.setUint32(20, height);
  return b;
}
