import { describe, expect, test } from "bun:test";
import { HttpError } from "../../src/core/errors.ts";
import { client, makeApp, png } from "./helpers.ts";

const json = (r: Response) => r.json() as Promise<any>;

describe("admin API: authentication and roles", () => {
  test("anonymous requests get 401 problem+json", async () => {
    const { app } = makeApp();
    for (const path of ["/admin/api/tours", "/admin/api/_meta", "/admin/api/tours/x"]) {
      const res = await app.request(path);
      expect(res.status).toBe(401);
      expect(res.headers.get("content-type")).toContain("application/problem+json");
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  test("an authenticated user without the admin role gets 403 (deny by default)", async () => {
    const { app } = makeApp();
    const v = await client(app, "viewer");
    expect((await v.call("GET", "/admin/api/tours")).status).toBe(403);
    expect((await v.call("POST", "/admin/api/tours", { title: "x" })).status).toBe(403);
    expect((await v.call("GET", "/admin/api/_meta")).status).toBe(403);
  });

  test("role arrays and predicates per action", async () => {
    const { app } = makeApp();
    const e = await client(app, "editor");
    expect((await e.call("GET", "/admin/api/tours")).status).toBe(403);
    expect((await e.call("GET", "/admin/api/categories")).status).toBe(200);
    const created = await e.call("POST", "/admin/api/categories", { name: "Museums" });
    expect(created.status).toBe(201);
    const id = (await json(created)).id;
    expect((await e.call("PATCH", `/admin/api/categories/${id}`, { name: "x" })).status).toBe(403);
    expect((await e.call("DELETE", `/admin/api/categories/${id}`)).status).toBe(403);
  });

  test("custom authorize() and roles() options", async () => {
    const { app } = makeApp({
      authorize: (c) => (c.req.headers.get("x-test-user") === "boss" ? { id: "b", perms: ["admin"] } : undefined),
      roles: (u: any) => u.perms,
    });
    expect((await app.request("/admin/api/tours", { headers: { "x-test-user": "boss" } })).status).toBe(200);
    expect((await app.request("/admin/api/tours", { headers: { "x-test-user": "nope" } })).status).toBe(401);
  });

  test("the UI page redirects browsers to loginUrl when signed out", async () => {
    const { app } = makeApp({ loginUrl: "/login" });
    const res = await app.request("/admin", { headers: { accept: "text/html" } });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login?next=%2Fadmin");
  });
});

describe("admin API: CRUD", () => {
  test("create applies defaults, strips unknown/readOnly/hidden fields; get/list/patch/delete", async () => {
    const { app, tours } = makeApp();
    const a = await client(app, "admin");
    const res = await a.call("POST", "/admin/api/tours", { title: "Louvre", hack: 1, views: 999, secret: "s", id: "chosen" });
    expect(res.status).toBe(201);
    const doc = await json(res);
    expect(doc).toMatchObject({ title: "Louvre", status: "draft", featured: false, views: 0 });
    expect(doc.hack).toBeUndefined();
    expect(doc.secret).toBeUndefined();
    expect(doc.id).not.toBe("chosen");
    expect(res.headers.get("cache-control")).toBe("no-store");

    await tours.update(doc.id, { secret: "server-only" });
    const got = await json(await a.call("GET", `/admin/api/tours/${doc.id}`));
    expect(got.title).toBe("Louvre");
    expect(got.secret).toBeUndefined();

    const patched = await a.call("PATCH", `/admin/api/tours/${doc.id}`, { status: "published", views: 5, rating: 4.5 });
    expect(patched.status).toBe(200);
    expect(await json(patched)).toMatchObject({ title: "Louvre", status: "published", views: 0, rating: 4.5 });

    const cleared = await json(await a.call("PATCH", `/admin/api/tours/${doc.id}`, { rating: null }));
    expect("rating" in cleared).toBe(false);

    expect((await a.call("DELETE", `/admin/api/tours/${doc.id}`)).status).toBe(204);
    const gone = await a.call("GET", `/admin/api/tours/${doc.id}`);
    expect(gone.status).toBe(404);
    expect(gone.headers.get("content-type")).toContain("problem+json");
    expect((await a.call("PATCH", `/admin/api/tours/${doc.id}`, { title: "x" })).status).toBe(404);
    expect((await a.call("DELETE", `/admin/api/tours/${doc.id}`)).status).toBe(404);
  });

  test("list: search, sort, filter[field] with type coercion, pagination, default sort", async () => {
    const { app } = makeApp({}, { defaultSort: "-rating" });
    const a = await client(app, "admin");
    for (const [i, title] of ["Kitchen", "Garden", "Garage", "Attic"].entries()) {
      await a.call("POST", "/admin/api/tours", { title, rating: i, featured: i % 2 === 0 });
    }
    const all = await json(await a.call("GET", "/admin/api/tours"));
    expect(all.total).toBe(4);
    expect(all.items[0].title).toBe("Attic"); // defaultSort -rating
    expect(all).toMatchObject({ limit: 50, offset: 0 });
    const q = await json(await a.call("GET", "/admin/api/tours?q=gar&sort=title"));
    expect(q.items.map((d: any) => d.title)).toEqual(["Garage", "Garden"]);
    const f = await json(await a.call("GET", "/admin/api/tours?filter[featured]=true&sort=rating"));
    expect(f.items.map((d: any) => d.title)).toEqual(["Kitchen", "Garage"]);
    const n = await json(await a.call("GET", "/admin/api/tours?filter[rating]=1"));
    expect(n.items.map((d: any) => d.title)).toEqual(["Garden"]);
    const j = await json(await a.call("GET", `/admin/api/tours?filter=${encodeURIComponent('{"rating":3}')}`));
    expect(j.items.map((d: any) => d.title)).toEqual(["Attic"]);
    const page = await json(await a.call("GET", "/admin/api/tours?sort=rating&limit=2&offset=2"));
    expect(page.items.map((d: any) => d.title)).toEqual(["Garage", "Attic"]);
  });

  test("list rejects unknown or hidden sort/filter fields with 400", async () => {
    const { app } = makeApp();
    const a = await client(app, "admin");
    expect((await a.call("GET", "/admin/api/tours?sort=nope")).status).toBe(400);
    expect((await a.call("GET", "/admin/api/tours?filter[secret]=x")).status).toBe(400);
    expect((await a.call("GET", "/admin/api/tours?filter[rating]=abc")).status).toBe(422);
  });

  test("validation errors are 422 problem+json with per-field issues", async () => {
    const { app } = makeApp();
    const a = await client(app, "admin");
    const res = await a.call("POST", "/admin/api/tours", { title: "", status: "gone", slug: "Bad Slug" });
    expect(res.status).toBe(422);
    const body = await json(res);
    const fields = body.issues.map((i: any) => i.path.join("."));
    expect(fields).toEqual(expect.arrayContaining(["body.title", "body.status", "body.slug"]));
    const missing = await json(await a.call("POST", "/admin/api/tours", {}));
    expect(missing.issues.map((i: any) => i.path.join("."))).toContain("body.title");

    const doc = await json(await a.call("POST", "/admin/api/tours", { title: "ok" }));
    const bad = await a.call("PATCH", `/admin/api/tours/${doc.id}`, { rating: "high" });
    expect(bad.status).toBe(422);
    expect((await json(bad)).issues[0].path).toEqual(["body", "rating"]);
  });

  test("relation fields must point at an existing record", async () => {
    const { app } = makeApp();
    const a = await client(app, "admin");
    const bad = await a.call("POST", "/admin/api/tours", { title: "x", categoryId: "missing" });
    expect(bad.status).toBe(422);
    expect((await json(bad)).issues[0].path).toEqual(["body", "categoryId"]);
    const cat = await json(await a.call("POST", "/admin/api/categories", { name: "Art" }));
    expect((await a.call("POST", "/admin/api/tours", { title: "x", categoryId: cat.id })).status).toBe(201);
  });

  test("hooks: beforeCreate/beforeUpdate transform data, afterChange observes, HttpError aborts", async () => {
    const seen: string[] = [];
    const { app } = makeApp({}, {
      hooks: {
        beforeCreate: (data: any) => ({ ...data, slug: data.title.toLowerCase() }),
        beforeUpdate: (patch: any, { before }: any) => {
          if (before.status === "published" && patch.status === "draft") throw new HttpError(409, "Cannot unpublish");
        },
        afterChange: ({ action, after }: any) => void seen.push(`${action}:${after?.slug ?? ""}`),
      },
    });
    const a = await client(app, "admin");
    const doc = await json(await a.call("POST", "/admin/api/tours", { title: "Rome", status: "published" }));
    expect(doc.slug).toBe("rome");
    expect((await a.call("PATCH", `/admin/api/tours/${doc.id}`, { status: "draft" })).status).toBe(409);
    expect(seen).toEqual(["create:rome"]);
  });

  test("audit log records who changed what", async () => {
    const { app, audit } = makeApp();
    const a = await client(app, "admin");
    const doc = await json(await a.call("POST", "/admin/api/tours", { title: "A" }));
    await a.call("PATCH", `/admin/api/tours/${doc.id}`, { title: "B" });
    await a.call("DELETE", `/admin/api/tours/${doc.id}`);
    const entries = (await audit.list({ sort: "at" })).items;
    expect(entries.map((e) => e.action)).toEqual(["create", "update", "delete"]);
    expect(entries[0]).toMatchObject({ user: "u1", resource: "tours", recordId: doc.id });
    expect(entries[1]!.changes).toEqual({ title: { from: "A", to: "B" } });
    expect(typeof entries[0]!.at).toBe("string");
  });
});

describe("admin API: CSRF", () => {
  test("cookie-authenticated writes need a matching x-csrf-token", async () => {
    const { app } = makeApp();
    const a = await client(app, "admin");
    const missing = await a.call("POST", "/admin/api/tours", { title: "x" }, { "x-csrf-token": "" });
    expect(missing.status).toBe(403);
    expect((await json(missing)).code).toBe("csrf_failed");
    expect((await a.call("POST", "/admin/api/tours", { title: "x" }, { "x-csrf-token": "wrong" })).status).toBe(403);
    expect((await a.call("POST", "/admin/api/tours", { title: "x" })).status).toBe(201);
  });

  test("cross-site Origin or Sec-Fetch-Site is rejected even with a valid token", async () => {
    const { app } = makeApp();
    const a = await client(app, "admin");
    expect((await a.call("POST", "/admin/api/tours", { title: "x" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await a.call("POST", "/admin/api/tours", { title: "x" }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await a.call("POST", "/admin/api/tours", { title: "x" }, { "sec-fetch-site": "same-origin" })).status).toBe(201);
  });

  test("trustedOrigins allows a known front-end origin", async () => {
    const { app } = makeApp({ trustedOrigins: ["https://admin.example"] });
    const a = await client(app, "admin");
    expect((await a.call("POST", "/admin/api/tours", { title: "x" }, { origin: "https://admin.example" })).status).toBe(201);
  });

  test("a token is bound to its session: logging in again invalidates it", async () => {
    const { app } = makeApp();
    const a = await client(app, "admin");
    const b = await client(app, "admin");
    expect((await a.call("POST", "/admin/api/tours", { title: "x" }, { "x-csrf-token": b.token })).status).toBe(403);
    // Re-login with the same cookie: the session id is regenerated (data kept), so the old token must die.
    const relog = await app.request("/login?as=admin", { method: "POST", headers: { cookie: a.cookie } });
    const cookie2 = (relog.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(cookie2).not.toBe(a.cookie);
    const post = (token: string) =>
      app.request("/admin/api/tours", {
        method: "POST",
        headers: { cookie: cookie2, "x-csrf-token": token, origin: "http://localhost", "content-type": "application/json" },
        body: JSON.stringify({ title: "x" }),
      });
    expect((await post(a.token)).status).toBe(403);
    const fresh = ((await (await app.request("/admin/api/_csrf", { headers: { cookie: cookie2 } })).json()) as { token: string }).token;
    expect(fresh).not.toBe(a.token);
    expect((await post(fresh)).status).toBe(201);
  });

  test("bearer-token requests (agents) are exempt", async () => {
    const { app } = makeApp();
    const res = await app.request("/admin/api/tours", {
      method: "POST",
      headers: { authorization: "Bearer tok-admin", "content-type": "application/json" },
      body: JSON.stringify({ title: "From agent" }),
    });
    expect(res.status).toBe(201);
  });

  test("safe methods do not need a token", async () => {
    const { app } = makeApp();
    const a = await client(app, "admin");
    expect((await app.request("/admin/api/tours", { headers: { cookie: a.cookie } })).status).toBe(200);
  });
});

describe("admin API: uploads", () => {
  test("image fields accept sniffed images only, set the field to the key and serve with nosniff", async () => {
    const { app, files } = makeApp();
    const a = await client(app, "admin");
    const doc = await json(await a.call("POST", "/admin/api/tours", { title: "x" }));
    const fd = new FormData();
    fd.append("file", new File([png(8, 4) as BlobPart], "cover.png", { type: "image/png" }));
    const up = await a.call("POST", `/admin/api/tours/${doc.id}/files/cover`, fd);
    expect(up.status).toBe(200);
    const out = await json(up);
    expect(out.file).toMatchObject({ contentType: "image/png", width: 8, height: 4 });
    expect(out.item.cover).toBe(out.file.key);
    expect(out.file.key).toStartWith("tours/cover/");
    expect(await files.head(out.file.key)).toBeDefined();

    const served = await a.call("GET", `/admin/api/tours/${doc.id}/files/cover`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await served.arrayBuffer()).length).toBe(33);
    expect((await app.request(`/admin/api/tours/${doc.id}/files/cover`)).status).toBe(401);

    // replacing deletes the previous blob
    const fd2 = new FormData();
    fd2.append("file", new File([png() as BlobPart], "b.png"));
    const out2 = await json(await a.call("POST", `/admin/api/tours/${doc.id}/files/cover`, fd2));
    expect(await files.head(out.file.key)).toBeUndefined();
    expect(await files.head(out2.file.key)).toBeDefined();
  });

  test("non-images are rejected for image fields; generic files are served as attachments", async () => {
    const { app } = makeApp();
    const a = await client(app, "admin");
    const doc = await json(await a.call("POST", "/admin/api/tours", { title: "x" }));
    const evil = new FormData();
    evil.append("file", new File(["<svg onload=alert(1)>"], "x.png", { type: "image/png" }));
    expect((await a.call("POST", `/admin/api/tours/${doc.id}/files/cover`, evil)).status).toBe(415);

    const fd = new FormData();
    fd.append("file", new File(["<html><script>alert(1)</script>"], "notes.html", { type: "text/html" }));
    expect((await a.call("POST", `/admin/api/tours/${doc.id}/files/attachment`, fd)).status).toBe(200);
    const served = await a.call("GET", `/admin/api/tours/${doc.id}/files/attachment`);
    expect(served.headers.get("content-type")).toBe("application/octet-stream");
    expect(served.headers.get("content-disposition")).toStartWith("attachment");
    expect(served.headers.get("content-security-policy")).toContain("sandbox");
  });

  test("size limit, unknown field, missing record, CSRF and permissions apply", async () => {
    const { app } = makeApp();
    const a = await client(app, "admin");
    const doc = await json(await a.call("POST", "/admin/api/tours", { title: "x" }));
    const big = new FormData();
    big.append("file", new File([new Uint8Array(4096)], "big.bin"));
    expect((await a.call("POST", `/admin/api/tours/${doc.id}/files/attachment`, big)).status).toBe(413);
    const fd = () => {
      const f = new FormData();
      f.append("file", new File([png() as BlobPart], "a.png"));
      return f;
    };
    expect((await a.call("POST", `/admin/api/tours/${doc.id}/files/title`, fd())).status).toBe(404);
    expect((await a.call("POST", `/admin/api/tours/missing/files/cover`, fd())).status).toBe(404);
    expect((await a.call("POST", `/admin/api/tours/${doc.id}/files/cover`, fd(), { "x-csrf-token": "x" })).status).toBe(403);
    const v = await client(app, "viewer");
    expect((await v.call("POST", `/admin/api/tours/${doc.id}/files/cover`, fd())).status).toBe(403);
  });

  test("image/file fields cannot be pointed at arbitrary keys through the JSON API", async () => {
    const { app } = makeApp();
    const a = await client(app, "admin");
    const doc = await json(await a.call("POST", "/admin/api/tours", { title: "x", cover: "other/secret.png" }));
    expect(doc.cover).toBeUndefined();
  });

  test("deleting a record deletes its files", async () => {
    const { app, files } = makeApp();
    const a = await client(app, "admin");
    const doc = await json(await a.call("POST", "/admin/api/tours", { title: "x" }));
    const fd = new FormData();
    fd.append("file", new File([png() as BlobPart], "a.png"));
    const { file } = await json(await a.call("POST", `/admin/api/tours/${doc.id}/files/cover`, fd));
    await a.call("DELETE", `/admin/api/tours/${doc.id}`);
    expect(await files.head(file.key)).toBeUndefined();
  });
});

describe("admin API: _meta", () => {
  test("describes resources with JSON Schema, widgets and the user's permissions", async () => {
    const { app } = makeApp({ title: "Tour Admin" });
    const a = await client(app, "admin");
    const meta = await json(await a.call("GET", "/admin/api/_meta"));
    expect(meta.title).toBe("Tour Admin");
    expect(meta.user).toMatchObject({ id: "u1", name: "Ada", roles: ["admin"] });
    const tours = meta.resources.find((r: any) => r.name === "tours");
    expect(tours).toMatchObject({ label: "Tours", titleField: "title", listFields: ["title", "status", "featured"], defaultSort: "-createdAt" });
    expect(tours.permissions).toEqual({ list: true, read: true, create: true, update: true, delete: true });
    expect(tours.schema.type).toBe("object");
    expect(tours.schema.properties.title).toMatchObject({ type: "string", minLength: 1 });
    expect(tours.schema.properties.secret).toBeUndefined();
    expect(tours.fields.title).toMatchObject({ widget: "text", required: true });
    expect(tours.fields.status).toMatchObject({ widget: "select", options: ["draft", "published"] });
    expect(tours.fields.featured.widget).toBe("checkbox");
    expect(tours.fields.rating.widget).toBe("number");
    expect(tours.fields.body.widget).toBe("markdown");
    expect(tours.fields.publishedOn.widget).toBe("date");
    expect(tours.fields.cover).toMatchObject({ widget: "image", readOnly: true });
    expect(tours.fields.views.readOnly).toBe(true);
    expect(tours.fields.categoryId).toMatchObject({ widget: "relation", relation: { resource: "categories", labelField: "name" } });
    expect(tours.fields.secret).toBeUndefined();
  });

  test("lists only resources the user may see", async () => {
    const { app } = makeApp();
    const e = await client(app, "editor");
    const meta = await json(await e.call("GET", "/admin/api/_meta"));
    expect(meta.resources.map((r: any) => r.name)).toEqual(["categories"]);
    expect(meta.resources[0].permissions).toEqual({ list: true, read: true, create: true, update: false, delete: false });
  });
});

describe("admin: options validation", () => {
  test("rejects bad resource names and relations to unknown resources", async () => {
    const { admin } = await import("../../src/admin/index.ts");
    const { memoryRepository } = await import("../../src/batteries/data/index.ts");
    const { t } = await import("../../src/core/schema.ts");
    expect(() => admin({ resources: { "bad name": { schema: t.object({}), repo: memoryRepository() } } })).toThrow(/resource name/);
    expect(() =>
      admin({
        resources: {
          a: { schema: t.object({ b: t.string() }), repo: memoryRepository(), fields: { b: { widget: "relation", relation: { resource: "zzz", labelField: "x" } } } },
        },
      }),
    ).toThrow(/unknown resource/);
    expect(() =>
      admin({ resources: { a: { schema: t.object({ b: t.string() }), repo: memoryRepository(), fields: { b: { widget: "image" } } } } }),
    ).toThrow(/files/);
  });
});
