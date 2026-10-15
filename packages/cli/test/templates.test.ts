import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { connect } from "@miujs/realtime/client";
import { REPO, cleanup, linkWorkspace, run, tempDir } from "./helpers.ts";

afterEach(cleanup);

const TEMPLATES = ["api", "fullstack", "quiz-game", "chat", "saas-starter", "crm", "game"];

/** A folder inside the repo, so generated apps sit next to the workspace packages. */
const inRepo = () => tempDir(join(import.meta.dir, "..", ".tmp"));

/** Stand-in for `bun install`: links the app's miujs / @miujs/* dependencies to the workspace packages. */
function install(appDir: string) {
  const pkg = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8"));
  const deps = Object.keys(pkg.dependencies ?? {}).filter((d) => d === "miujs" || d.startsWith("@miujs/") || d === "drizzle-orm");
  linkWorkspace(appDir, deps);
  return deps;
}

describe("miu new --template", () => {
  for (const template of TEMPLATES) {
    test(`${template}: the generated app passes its own miu test and miu inspect`, async () => {
      const dir = inRepo();
      const made = await run(["new", "my-app", "--template", template], dir);
      expect(made.err).toBe("");
      expect(made.code).toBe(0);
      const app = join(dir, "my-app");
      for (const f of ["app.ts", "package.json", "tsconfig.json", "AGENTS.md", ".gitignore"]) expect(existsSync(join(app, f))).toBe(true);
      const deps = install(app);
      expect(deps).toContain("miujs");

      const tested = await run(["test"], app);
      expect(tested.err).toBe("");
      expect(tested.out).toMatch(/[1-9]\d* passed, 0 failed/);
      expect(tested.code).toBe(0);

      const inspected = await run(["inspect", "--json"], app);
      expect(inspected.code).toBe(0);
      expect(JSON.parse(inspected.out).name).toBe("my-app");
    }, 30_000);
  }

  test("crm and game say the kit is in progress", async () => {
    for (const t of ["crm", "game"]) {
      const r = await run(["new", `x-${t}`, "--template", t], inRepo());
      expect(r.out).toContain("kit in progress; generating a minimal starter");
    }
  });

  test("templates declare the batteries they use", async () => {
    const dir = inRepo();
    const deps = async (t: string) => {
      await run(["new", t, "--template", t], dir);
      return Object.keys(JSON.parse(readFileSync(join(dir, t, "package.json"), "utf8")).dependencies);
    };
    expect(await deps("fullstack")).toContain("@miujs/web");
    expect(await deps("chat")).toContain("@miujs/realtime");
    expect(await deps("game")).toContain("@miujs/realtime");
    for (const d of ["@miujs/auth", "@miujs/session", "@miujs/access", "@miujs/mail", "@miujs/audit", "@miujs/workflows", "@miujs/db"]) expect(await deps("saas-starter")).toContain(d);
    for (const d of ["@miujs/access", "@miujs/db", "@miujs/workflows"]) expect(await deps("crm")).toContain(d);
  });

  test("fullstack renders a JSX page that loads htmx", async () => {
    const dir = inRepo();
    await run(["new", "web", "--template", "fullstack"], dir);
    const files = ["app.ts", "routes/home.tsx"].map((f) => readFileSync(join(dir, "web", f), "utf8")).join("\n");
    expect(files).toContain("htmx.org");
    expect(files).toContain("hx-post");
    expect(JSON.parse(readFileSync(join(dir, "web", "tsconfig.json"), "utf8")).compilerOptions.jsxImportSource).toBe("@miujs/web");
  });

  test("quiz-game is a copy of examples/quiz", async () => {
    const dir = inRepo();
    await run(["new", "quiz", "--template", "quiz-game"], dir);
    for (const f of ["room.ts", "public/index.html"]) {
      expect(readFileSync(join(dir, "quiz", f), "utf8")).toBe(readFileSync(join(REPO, "examples", "quiz", f), "utf8"));
    }
  });

  test("an unknown template is MIU_E_CLI_TEMPLATE and lists the real ones", async () => {
    const r = await run(["new", "x", "--template", "blog"], inRepo());
    expect(r.code).toBe(1);
    expect(r.err).toContain("MIU_E_CLI_TEMPLATE");
    for (const t of TEMPLATES) expect(r.err).toContain(t);
  });
});

// ---- the generated apps really work (beyond their own route tests) ------------------------------

async function generate(template: string) {
  const dir = inRepo();
  expect((await run(["new", "app", "--template", template], dir)).code).toBe(0);
  const appDir = join(dir, "app");
  install(appDir);
  const mod = await import(pathToFileURL(join(appDir, "app.ts")).href);
  const app = mod.default;
  await app.ready();
  return { app, mod };
}

/** Minimal cookie jar + JSON requests against app.fetch (same origin, so CSRF checks pass). */
function client(app: { fetch(r: Request): Promise<Response> }) {
  const jar = new Map<string, string>();
  return async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const h = new Headers({ origin: "http://localhost", ...headers });
    if (jar.size) h.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
    if (body !== undefined) h.set("content-type", "application/json");
    const res = await app.fetch(new Request(`http://localhost${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }));
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json, text };
  };
}

describe("generated apps end to end", () => {
  test("saas-starter: register → org → project → audit entry and welcome workflow", async () => {
    const { app } = await generate("saas-starter");
    const call = client(app);
    expect((await call("POST", "/auth/register", { email: "ann@example.com", password: "correct horse battery" })).status).toBeLessThan(300);
    const org = await call("POST", "/orgs", { name: "Acme" });
    expect(org.status).toBe(201);
    const orgId = org.json.org.id;
    const made = await call("POST", "/projects", { name: "Apollo" }, { "x-org-id": orgId });
    expect(made.status).toBe(201);
    const list = await call("GET", "/projects", undefined, { "x-org-id": orgId });
    expect(list.json.projects.map((p: { name: string }) => p.name)).toEqual(["Apollo"]);
    const log = await call("GET", "/audit", undefined, { "x-org-id": orgId });
    expect(log.status).toBe(200);
    expect(JSON.stringify(log.json)).toContain("projects");
    let runs: any = null;
    for (let i = 0; i < 50; i++) {
      runs = await call("GET", "/workflows/runs?workflow=project-welcome", undefined, { "x-org-id": orgId });
      if (JSON.stringify(runs.json).includes("completed")) break;
      await Bun.sleep(20);
    }
    expect(runs.status).toBe(200);
    expect(JSON.stringify(runs.json)).toContain("completed");
    // The welcome email really went out through the mail plugin.
    const runId = JSON.stringify(runs.json).match(/"id":"([0-9a-f-]{36})"/)![1];
    const one = await call("GET", `/workflows/runs/${runId}`, undefined, { "x-org-id": orgId });
    expect(JSON.stringify(one.json)).toContain('"sent":true');
    // Another org's id is refused: tenant isolation comes from access, not the request body.
    expect((await call("GET", "/projects", undefined, { "x-org-id": "someone-else" })).status).toBe(403);
  }, 30_000);

  test("crm: contacts are scoped to the org and start the follow-up workflow", async () => {
    const { app } = await generate("crm");
    const call = client(app);
    expect((await call("POST", "/auth/register", { email: "bo@example.com", password: "correct horse battery" })).status).toBeLessThan(300);
    const orgId = (await call("POST", "/orgs", { name: "Shop" })).json.org.id;
    const made = await call("POST", "/contacts", { name: "Ada", email: "ada@example.com" }, { "x-org-id": orgId });
    expect(made.status).toBe(201);
    expect(made.json.stage).toBe("lead");
    const moved = await call("PATCH", `/contacts/${made.json.id}/stage`, { stage: "qualified" }, { "x-org-id": orgId });
    expect(moved.json.stage).toBe("qualified");
    expect((await call("GET", "/contacts?stage=qualified", undefined, { "x-org-id": orgId })).json.contacts).toHaveLength(1);
    const runs = await call("GET", "/workflows/runs?workflow=contact-follow-up", undefined, { "x-org-id": orgId });
    expect(runs.status).toBe(200);
    expect(JSON.stringify(runs.json)).toContain("contact-follow-up");
  }, 30_000);

  test("chat and game rooms work over real WebSockets", async () => {
    const chat = await generate("chat");
    const game = await generate("game");
    const servers = [await chat.app.listen(0), await game.app.listen(0)];
    try {
      const ws = (s: { url: string }, path: string) => s.url.replace("http", "ws") + path;
      const ann = connect(ws(servers[0], "rooms/chat/lobby"), { name: "Ann" });
      await ann.ready;
      ann.send("say", { text: "hello" });
      await waitFor(() => ann.state?.messages?.length === 1);
      expect(ann.state.messages[0]).toMatchObject({ from: "Ann", text: "hello" });
      ann.close();

      const x = connect(ws(servers[1], "rooms/tictactoe/t1"), { name: "X" });
      await x.ready;
      const o = connect(ws(servers[1], "rooms/tictactoe/t1"), { name: "O" });
      await o.ready;
      for (const [p, cell] of [[x, 0], [o, 3], [x, 1], [o, 4], [x, 2]] as const) {
        const before = p.state.board.filter(Boolean).length;
        p.send("move", { cell });
        await waitFor(() => p.state.board.filter(Boolean).length === before + 1);
      }
      expect(x.state.winner).toBe("X");
      x.close();
      o.close();
    } finally {
      for (const s of servers) await s.stop();
    }
  }, 30_000);
});

async function waitFor(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
}
