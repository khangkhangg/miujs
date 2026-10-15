import { describe, expect, test } from "bun:test";
import { createApp } from "../app.ts";

const SECRET = "example-secret-that-is-long-enough-0123456789";
const BASE = "http://localhost";

/** Minimal cookie-carrying client, like a browser on the same origin. */
function client(app: ReturnType<typeof createApp>["app"]) {
  let cookie = "";
  return async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const headers = new Headers({ origin: BASE });
    if (cookie) headers.set("cookie", cookie);
    if (init.body !== undefined) headers.set("content-type", "application/json");
    const res = await app.fetch(new Request(BASE + path, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) }));
    for (const c of res.headers.getSetCookie()) cookie = c.split(";")[0];
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };
}

function setup() {
  const made = createApp({ sessionSecret: SECRET, passwordIterations: 1000, dev: true });
  return { ...made, call: client(made.app) };
}

describe("notes API", () => {
  test("notes require sign-in", async () => {
    const { call } = setup();
    expect((await call("/notes")).status).toBe(401);
  });

  test("a registered user can create and list their notes", async () => {
    const { call } = setup();
    expect((await call("/auth/register", { method: "POST", body: { email: "mia@example.com", password: "correct horse" } })).status).toBe(201);
    const created = await call("/notes", { method: "POST", body: { title: "Buy tea", body: "oolong" } });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ title: "Buy tea", body: "oolong" });
    const list = await call("/notes");
    expect(list.body.notes.map((n: { title: string }) => n.title)).toEqual(["Buy tea"]);
  });

  test("users cannot read each other's notes", async () => {
    const { app } = setup();
    const a = client(app);
    const b = client(app);
    await a("/auth/register", { method: "POST", body: { email: "a@example.com", password: "password-a" } });
    await b("/auth/register", { method: "POST", body: { email: "b@example.com", password: "password-b" } });
    const note = await a("/notes", { method: "POST", body: { title: "secret" } });
    expect((await b(`/notes/${note.body.id}`)).status).toBe(404);
    expect((await b("/notes")).body.notes).toEqual([]);
  });

  test("the list cache is invalidated when a note is added", async () => {
    const { call } = setup();
    await call("/auth/register", { method: "POST", body: { email: "c@example.com", password: "password-c" } });
    expect((await call("/notes")).body.notes.length).toBe(0); // primes the cache
    await call("/notes", { method: "POST", body: { title: "one" } });
    expect((await call("/notes")).body.notes.length).toBe(1);
  });

  test("creating a note runs the background job", async () => {
    const { call, jobs } = setup();
    await call("/auth/register", { method: "POST", body: { email: "d@example.com", password: "password-d" } });
    await call("/notes", { method: "POST", body: { title: "with job" } });
    await jobs.adapter.drain();
    expect(jobs.ranFor).toEqual(["with job"]);
  });

  test("deleting a note returns 204 and removes it", async () => {
    const { call } = setup();
    await call("/auth/register", { method: "POST", body: { email: "e@example.com", password: "password-e" } });
    const note = await call("/notes", { method: "POST", body: { title: "temp" } });
    expect((await call(`/notes/${note.body.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await call(`/notes/${note.body.id}`)).status).toBe(404);
  });

  test("every note route is an MCP tool", async () => {
    const { app } = setup();
    await app.ready();
    expect(app.inspect().mcp?.tools).toEqual(expect.arrayContaining(["listNotes", "createNote", "getNote", "deleteNote"]));
  });
});
