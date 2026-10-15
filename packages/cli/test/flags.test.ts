import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanup, fakeRunner, fixture, run, tempDir } from "./helpers.ts";

afterEach(cleanup);

describe("help", () => {
  test("lists every command", async () => {
    const r = await run(["help"], tempDir());
    for (const c of ["miu dev", "miu test", "miu inspect", "miu openapi", "miu check", "miu add", "miu new", "miu deploy", "miu db pull", "miu db migrate", "miu loadtest", "miu logs"]) {
      expect(r.out).toContain(c);
    }
    for (const t of ["cloudflare", "fly", "railway", "render", "vps", "binary", "deno-deploy"]) expect(r.out).toContain(t);
    for (const t of ["api", "fullstack", "quiz-game", "chat", "saas-starter", "crm", "game"]) expect(r.out).toContain(t);
  });

  test("explains _miu_migrations versus wrangler's d1_migrations", async () => {
    const r = await run(["help"], tempDir());
    expect(r.out).toContain("_miu_migrations");
    expect(r.out).toContain("d1_migrations");
  });

  test("<command> --help prints help", async () => {
    const r = await run(["logs", "--help"], tempDir());
    expect(r.code).toBe(0);
    expect(r.out).toContain("miu logs");
  });
});

describe("flags", () => {
  test("an unknown flag is a MIU_E_CLI_UNKNOWN_FLAG error that lists the valid ones", async () => {
    const r = await run(["inspect", "--jsn"], fixture("basic"));
    expect(r.code).toBe(1);
    expect(r.err).toContain("MIU_E_CLI_UNKNOWN_FLAG");
    expect(r.err).toContain("--jsn");
    expect(r.err).toContain("fix:");
    expect(r.err).toContain("--json");
  });

  test("a flag that needs a value reports MIU_E_CLI_FLAG_VALUE", async () => {
    const r = await run(["openapi", "--out"], fixture("basic"));
    expect(r.code).toBe(1);
    expect(r.err).toContain("MIU_E_CLI_FLAG_VALUE");
    expect(r.err).toContain("--out");
  });

  test("--flag=value works like --flag value", async () => {
    const r = await run(["inspect", "--entry=app.ts", "--json"], fixture("basic"));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).name).toBe("basic-fixture");
  });

  test("unknown db subcommand is a MIU_E_CLI_ error with a fix", async () => {
    const r = await run(["db", "frob"], tempDir());
    expect(r.code).toBe(1);
    expect(r.err).toContain("MIU_E_CLI_DB_USAGE");
    expect(r.err).toContain("fix:");
  });
});

describe("runner-backed commands", () => {
  test("miu dev runs bun --hot on the entry with MIU_ENV=development", async () => {
    const { runner, calls } = fakeRunner();
    const r = await run(["dev"], fixture("basic"), runner);
    expect(r.code).toBe(0);
    expect(calls[0].cmd).toEqual([process.execPath, "--hot", join(fixture("basic"), "app.ts")]);
    expect(calls[0].opts.env?.MIU_ENV).toBe("development");
  });

  test("miu deploy cloudflare (no --dry-run) runs wrangler deploy through the runner", async () => {
    const dir = tempDir();
    const out = join(dir, "wrangler.toml");
    const { runner, calls } = fakeRunner();
    const r = await run(["deploy", "cloudflare", "--out", out], fixture("basic"), runner);
    expect(r.code).toBe(0);
    expect(calls[0].cmd.slice(calls[0].cmd.indexOf("wrangler"))).toEqual(["wrangler", "deploy", "--config", out]);
  });

  test("unknown flags on new and add are reported too", async () => {
    expect((await run(["new", "x", "--tmplate", "api"], tempDir())).err).toContain("MIU_E_CLI_UNKNOWN_FLAG");
    expect((await run(["add", "route", "x", "--force"], tempDir())).err).toContain("takes no flags");
  });
});
