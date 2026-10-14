import { describe, expect, test } from "bun:test";
import { parseArgs } from "../../src/cli/args.ts";
import { generateWranglerToml } from "../../src/cli/wrangler.ts";

describe("parseArgs", () => {
  test("positionals, --flag value, --flag=value, booleans, repeats, --", () => {
    const a = parseArgs(["create", "my-app", "--template", "node", "--name=hi", "--force", "--kv", "A", "--kv", "B", "--", "--literal"], {
      boolean: ["force"],
    });
    expect(a._).toEqual(["create", "my-app", "--literal"]);
    expect(a.flags.template).toBe("node");
    expect(a.flags.name).toBe("hi");
    expect(a.flags.force).toBe(true);
    expect(a.flags.kv).toEqual(["A", "B"]);
  });

  test("short aliases -h and -v", () => {
    expect(parseArgs(["-h"], { boolean: ["help"], alias: { h: "help" } }).flags.help).toBe(true);
    expect(parseArgs(["-v"], { boolean: ["version"], alias: { v: "version" } }).flags.version).toBe(true);
  });

  test("a value flag at the end is an error", () => {
    expect(() => parseArgs(["--out"], {})).toThrow(/--out requires a value/);
  });

  test("boolean flag before a positional does not swallow it", () => {
    const a = parseArgs(["--full", "app.ts"], { boolean: ["full"] });
    expect(a.flags.full).toBe(true);
    expect(a._).toEqual(["app.ts"]);
  });
});

describe("generateWranglerToml", () => {
  test("basic config with today's compatibility date and nodejs_compat off", () => {
    const toml = generateWranglerToml({ name: "my-app", date: new Date("2026-03-04T12:00:00Z") });
    expect(toml).toContain('name = "my-app"');
    expect(toml).toContain('main = "src/worker.ts"');
    expect(toml).toContain('compatibility_date = "2026-03-04"');
    expect(toml).toContain('# compatibility_flags = ["nodejs_compat"]');
    expect(toml).not.toMatch(/^compatibility_flags/m);
  });

  test("nodejs_compat when asked", () => {
    expect(generateWranglerToml({ name: "a", nodejsCompat: true })).toMatch(/^compatibility_flags = \["nodejs_compat"\]$/m);
  });

  test("bindings: kv, d1, r2, queue, durable objects", () => {
    const toml = generateWranglerToml({
      name: "shop",
      kv: ["CACHE"],
      d1: ["DB:shop-db"],
      r2: ["UPLOADS"],
      queue: ["JOBS"],
      do: ["Room", "COUNTER:Counter"],
    });
    expect(toml).toContain('[[kv_namespaces]]\nbinding = "CACHE"\nid = "<CACHE_KV_ID>"');
    expect(toml).toContain('[[d1_databases]]\nbinding = "DB"\ndatabase_name = "shop-db"\ndatabase_id = "<DB_D1_ID>"');
    expect(toml).toContain('[[r2_buckets]]\nbinding = "UPLOADS"\nbucket_name = "shop-uploads"');
    expect(toml).toContain('[[queues.producers]]\nbinding = "JOBS"\nqueue = "shop-jobs"');
    expect(toml).toContain('[[queues.consumers]]\nqueue = "shop-jobs"');
    expect(toml).toContain('[[durable_objects.bindings]]\nname = "ROOM"\nclass_name = "Room"');
    expect(toml).toContain('[[durable_objects.bindings]]\nname = "COUNTER"\nclass_name = "Counter"');
    expect(toml).toContain('[[migrations]]\ntag = "v1"\nnew_sqlite_classes = ["Room", "Counter"]');
  });

  test("rejects invalid binding names", () => {
    expect(() => generateWranglerToml({ name: "a", kv: ["bad name"] })).toThrow(/Invalid binding/);
  });
});
