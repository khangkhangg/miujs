/**
 * Application benchmark: Tour Studio (apps/tour-studio) under a realistic mixed load, on Bun and on Node.
 *
 *   bun bench/app.ts [--duration 10] [--concurrency 64] [--workers 2] [--warmup 2] [--width 2048]
 *                    [--runtimes bun,node] [--profile 6] [--out bench/results-tour-studio.md]
 *                    [--variants "bun:LOG_REQUESTS=0;bun:SQLITE_SYNCHRONOUS=NORMAL;node:UV_THREADPOOL_SIZE=16"]
 *
 * 1. Seeds a fresh data dir (admin + the 3-room demo tour, `--width` px panoramas).
 * 2. For each runtime: copies the seeded dir, starts the server in production mode (JSON access log on,
 *    written to a file), runs bench/scenarios/tour-studio.ts, records the table and the server's peak RSS.
 * 2b. Variants: the same run with one setting changed (to attribute cost: access log, fsync, Node's thread pool).
 * 3. Profiles a short Bun run with `bun --cpu-prof` and lists the hottest functions (self time).
 * 4. Writes the results file. Anything after the "hand-written analysis" marker in an existing file is kept.
 */
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, release, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { runScenario, type Report } from "./lib/scenario.ts";

const ROOT = new URL("../", import.meta.url).pathname;
const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1]! : def;
};
const duration = Number(arg("duration", "10"));
const concurrency = Number(arg("concurrency", "64"));
const workers = Number(arg("workers", "2"));
const warmup = Number(arg("warmup", "2"));
const width = arg("width", "2048");
const runtimes = arg("runtimes", "bun,node").split(",").filter(Boolean) as ("bun" | "node")[];
const profileSeconds = Number(arg("profile", "6"));
const variants = arg("variants", "bun:LOG_REQUESTS=0;bun:SQLITE_SYNCHRONOUS=NORMAL;node:UV_THREADPOOL_SIZE=16")
  .split(";")
  .filter(Boolean)
  .map((v) => {
    const [rt, kv] = v.split(":") as ["bun" | "node", string];
    const [k, val] = kv.split("=") as [string, string];
    return { runtime: rt, env: { [k]: val }, label: kv };
  });
const out = join(ROOT, arg("out", "bench/results-tour-studio.md"));
const SCENARIO = join(ROOT, "bench/scenarios/tour-studio.ts");
const fmt = (v: number) => Math.round(v).toLocaleString("en-US");
const MARKER = "<!-- hand-written analysis below: kept across runs -->";

const work = mkdtempSync(join(tmpdir(), "tour-studio-bench-"));
const baseEnv = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  MIU_ENV: "production",
  NODE_ENV: "production",
  SESSION_SECRET: "bench-session-secret-0123456789abcdefghij",
  ADMIN_PASSWORD: "bench-admin-password",
  COOKIE_SECURE: "0",
  PORT: "0",
};

async function sh(cmd: string[], env: Record<string, string>) {
  const p = Bun.spawn(cmd, { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" });
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  if ((await p.exited) !== 0) throw new Error(`${cmd.join(" ")} failed:\n${o}\n${e}`);
  return o;
}

interface Running {
  url: string;
  pid: number;
  logFile: string;
  stop: () => Promise<void>;
}

async function start(runtime: "bun" | "node", dataDir: string, extra: string[] = [], env: Record<string, string> = {}): Promise<Running> {
  const entry = join(ROOT, "apps/tour-studio", runtime === "bun" ? "server.ts" : "server-node.ts");
  const cmd = runtime === "bun" ? ["bun", ...extra, entry] : ["node", "--experimental-strip-types", "--no-warnings", ...extra, entry];
  const logFile = join(work, `${runtime}-${Date.now()}.log`);
  const proc = Bun.spawn(cmd, { cwd: ROOT, env: { ...baseEnv, DATA_DIR: dataDir, SEED: "0", ...env }, stdout: Bun.file(logFile), stderr: "pipe" });
  let err = "";
  void new Response(proc.stderr).text().then((t) => (err += t));
  const deadline = Date.now() + 30_000;
  for (;;) {
    const log = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
    const m = /listening on (http:\/\/\S+)/.exec(log);
    if (m) return { url: m[1]!, pid: proc.pid, logFile, stop: async () => void (proc.kill("SIGTERM"), await proc.exited) };
    if (proc.exitCode !== null || Date.now() > deadline) throw new Error(`${runtime} server failed to start:\n${log}\n${err}`);
    await Bun.sleep(50);
  }
}

function peakRssMb(pid: number): number | undefined {
  try {
    const m = /VmHWM:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    return m ? Math.round(Number(m[1]) / 1024) : undefined;
  } catch {
    return undefined;
  }
}

// ---------- CPU profile analysis ----------
interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
}
function topFunctions(file: string, n = 20) {
  const prof = JSON.parse(readFileSync(file, "utf8")) as { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[] };
  const byId = new Map(prof.nodes.map((x) => [x.id, x]));
  const parent = new Map<number, number>();
  for (const x of prof.nodes as (ProfileNode & { children?: number[] })[]) for (const ch of x.children ?? []) parent.set(ch, x.id);
  /** Native frames charged to the nearest framework/app caller: shows *which* code spends the native time. */
  const viaCaller = new Map<string, number>();
  const self = new Map<string, number>();
  const area = new Map<string, number>();
  let total = 0;
  let idle = 0;
  prof.samples.forEach((id, i) => {
    const dt = prof.timeDeltas[i] ?? 0;
    const node = byId.get(id);
    const f = node?.callFrame;
    const name = f?.functionName || "(anonymous)";
    if (name === "(idle)" || name === "(root)") {
      idle += dt;
      return;
    }
    total += dt;
    const url = (f?.url ?? "").replace(/^file:\/\//, "").replace(ROOT, "");
    const key = `${name} ${url ? `${url}:${(f?.lineNumber ?? 0) + 1}` : "(native)"}`;
    self.set(key, (self.get(key) ?? 0) + dt);
    if (!url) {
      let cur = parent.get(id);
      let caller = "";
      while (cur !== undefined && !caller) {
        const cf = byId.get(cur)?.callFrame;
        const u = (cf?.url ?? "").replace(/^file:\/\//, "").replace(ROOT, "");
        // Skip the thin bun:sqlite/node:sqlite wrappers to reach the repository/store method (async code loses
        // the callers above it, so that is as far as a sampled stack reaches).
        const driver = u === "src/batteries/sqlite.ts" || u === "src/batteries/data/sqlite.ts";
        if ((u.startsWith("src/") || u.startsWith("apps/")) && !driver) caller = `${cf!.functionName || "(anonymous)"} ${u}:${cf!.lineNumber + 1}`;
        cur = parent.get(cur);
      }
      const k = `${name} ← ${caller || "(runtime)"}`;
      viaCaller.set(k, (viaCaller.get(k) ?? 0) + dt);
    }
    const a = !url ? (name.startsWith("(") ? name : "native / runtime") : url.startsWith("src/") ? url.split("/").slice(0, url.startsWith("src/batteries/") || url.startsWith("src/adapters/") ? 3 : 2).join("/") : url.startsWith("apps/") ? "apps/tour-studio" : url.includes("node_modules") ? "node_modules" : `builtin: ${url.split("/").pop()}`;
    area.set(a, (area.get(a) ?? 0) + dt);
  });
  const pct = (v: number) => ((100 * v) / total).toFixed(1);
  const top = [...self].sort((a, b) => b[1] - a[1]).slice(0, n);
  const areas = [...area].sort((a, b) => b[1] - a[1]).slice(0, 12);
  return [
    `Busy ${(total / 1e6).toFixed(1)} s of ${((total + idle) / 1e6).toFixed(1)} s sampled (${((100 * total) / (total + idle)).toFixed(0)}% CPU).`,
    "",
    "| Self % | Function (file:line) |",
    "| ---: | --- |",
    ...top.map(([k, v]) => `| ${pct(v)} | \`${k.replace(/\|/g, "\\|")}\` |`),
    "",
    "Native time by the framework/app function that called it (repository/store method for SQLite):",
    "",
    "| % of busy | Native ← caller |",
    "| ---: | --- |",
    ...[...viaCaller].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => `| ${pct(v)} | \`${k.replace(/\|/g, "\\|")}\` |`),
    "",
    "By area (self time):",
    "",
    "| Self % | Area |",
    "| ---: | --- |",
    ...areas.map(([k, v]) => `| ${pct(v)} | ${k} |`),
  ].join("\n");
}

// ---------- run ----------
const seeded = join(work, "seed");
console.log(`seeding ${seeded} (${width}px panoramas)…`);
await sh(["bun", join(ROOT, "apps/tour-studio/seed.ts")], { ...baseEnv, DATA_DIR: seeded, SEED_PANORAMA_WIDTH: width });
const panoBytes = readdirSync(join(seeded, "panoramas/data")).map((f) => Bun.file(join(seeded, "panoramas/data", f)).size);

const reports: { runtime: string; version: string; report: Report; rss?: number; logLines: number }[] = [];
for (const runtime of runtimes) {
  const dir = join(work, runtime);
  cpSync(seeded, dir, { recursive: true });
  const server = await start(runtime, dir);
  console.log(`${runtime}: ${server.url} — running ${duration}s (warmup ${warmup}s, concurrency ${concurrency}, ${workers} workers)…`);
  const report = await runScenario({ scenario: SCENARIO, url: server.url, duration, concurrency, workers, warmup });
  const rss = peakRssMb(server.pid);
  await server.stop();
  const logLines = readFileSync(server.logFile, "utf8").split("\n").filter((l) => l.startsWith("{")).length;
  const version = runtime === "bun" ? `Bun ${Bun.version}` : `Node ${(await sh(["node", "--version"], baseEnv)).trim()}`;
  console.log(report.markdown);
  reports.push({ runtime, version, report, rss, logLines });
}

const variantRows: string[] = [];
for (const v of variants) {
  if (!runtimes.includes(v.runtime)) continue;
  const dir = join(work, `variant-${variantRows.length}`);
  cpSync(seeded, dir, { recursive: true });
  const server = await start(v.runtime, dir, [], v.env);
  console.log(`${v.runtime} with ${v.label}: running ${duration}s…`);
  const report = await runScenario({ scenario: SCENARIO, url: server.url, duration, concurrency, workers, warmup });
  await server.stop();
  const baseline = reports.find((r) => r.runtime === v.runtime)!.report.total;
  const byName = (r: Report, n: string) => r.steps.find((s) => s.name === n)!;
  const step = (n: string) => `${Math.round(byName(report, n).p50 * 10) / 10}`;
  variantRows.push(
    `| ${v.runtime} | \`${v.label}\` | ${fmt(report.total.rps)} | ${((100 * report.total.rps) / baseline.rps - 100).toFixed(0)}% | ${report.total.errors} | ${report.total.p50.toFixed(2)} | ${report.total.p99.toFixed(1)} | ${step("creator write (hotspot create+delete)")} | ${step("media 200 full")} |`,
  );
  console.log(variantRows.at(-1));
}

let profile = "";
if (profileSeconds > 0) {
  const dir = join(work, "profile");
  cpSync(seeded, dir, { recursive: true });
  const profDir = join(work, "cpuprof");
  const server = await start("bun", dir, ["--cpu-prof", `--cpu-prof-dir=${profDir}`]);
  console.log(`profiling bun for ${profileSeconds}s…`);
  await runScenario({ scenario: SCENARIO, url: server.url, duration: profileSeconds, concurrency, workers, warmup: 1 });
  await server.stop();
  await Bun.sleep(500);
  const file = existsSync(profDir) ? readdirSync(profDir).find((f) => f.endsWith(".cpuprofile")) : undefined;
  profile = file ? topFunctions(join(profDir, file)) : "_No .cpuprofile was written._";
  console.log(profile);
}

const cpu = cpus();
const machine = `${cpu.length} × ${cpu[0]?.model ?? "unknown CPU"}, ${Math.round(totalmem() / 2 ** 30)} GiB RAM, Linux ${release()}`;
const kept = existsSync(out) && readFileSync(out, "utf8").includes(MARKER) ? readFileSync(out, "utf8").split(MARKER)[1]!.trim() : "_(analysis goes here)_";

const summary = [
  "| Runtime | Req/s | Errors | p50 ms | p99 ms | Peak RSS | Access-log lines |",
  "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ...reports.map((r) => `| ${r.version} | ${fmt(r.report.total.rps)} | ${r.report.total.errors} | ${r.report.total.p50.toFixed(2)} | ${r.report.total.p99.toFixed(1)} | ${r.rss ?? "?"} MB | ${fmt(r.logLines)} |`),
].join("\n");

const md = `# Tour Studio — application benchmark

Generated by \`bun bench/app.ts\` (${new Date().toISOString().slice(0, 10)}). Scenario: [bench/scenarios/tour-studio.ts](scenarios/tour-studio.ts).

- **Machine:** ${machine}. Load generator (${workers} Bun worker processes) and server share the machine.
- **Run:** ${duration} s measured after ${warmup} s warmup, ${concurrency} concurrent connections, keep-alive.
- **App:** \`apps/tour-studio\` in production mode (\`MIU_ENV=production\`): SQLite (WAL) for data, sessions and
  rate limits, \`diskBlobStore\` for panoramas, JSON access log to a file, secure headers, sessions + auth on every
  request. Bun: \`Bun.serve(app.serveOptions())\`; Node: \`serve()\` from \`miujs/node\` with \`--experimental-strip-types\`.
- **Data:** the seeded demo tour (3 scenes, ${width}×${Number(width) / 2} PNG panoramas of ${panoBytes.map((b) => `${Math.round(b / 1024)} KiB`).join(", ")}) plus a
  creator's 2-scene tour created in \`setup()\` over HTTP.

## Summary

${summary}

${reports.map((r) => `## ${r.version}\n\n${r.report.markdown}`).join("\n\n")}

## Variants (one setting changed, same mix)

| Runtime | Change | Req/s | vs default | Errors | p50 ms | p99 ms | write p50 ms | media 200 p50 ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${variantRows.join("\n")}

## CPU profile (Bun, ${profileSeconds} s of the same mix, \`bun --cpu-prof\`)

${profile}

${MARKER}

${kept}
`;
writeFileSync(out, md);
if (!process.env.KEEP_BENCH_DIR) rmSync(work, { recursive: true, force: true });
else console.log(`kept ${work}`);
console.log(`wrote ${out}`);
