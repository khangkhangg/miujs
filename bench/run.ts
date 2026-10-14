// bun run.ts [--duration 3] [--concurrency 64] [--workers 2] [--warmup 1] [--only miu,hono]
// Starts each framework's server in a subprocess, warms up, drives load from separate worker
// processes, prints req/s per route as a Markdown table and writes results.md.
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { join } from "node:path";

const dir = import.meta.dir;
const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1]! : def;
};
const duration = Number(arg("duration", "3"));
const warmup = Number(arg("warmup", "1"));
const concurrency = Number(arg("concurrency", "64"));
const workers = Number(arg("workers", "2"));
const only = arg("only", "miu,hono,elysia").split(",");

const ROUTES = [
  { name: "GET / (text)", method: "GET", path: "/", expect: "Hi" },
  { name: "GET /user/:id (JSON)", method: "GET", path: "/user/42", expect: '{"id":"42"}' },
  { name: "POST /json (validated echo)", method: "POST", path: "/json", body: '{"name":"miu","age":3}', expect: '{"name":"miu","age":3}' },
];

const frameworks = only.filter((f) => {
  if (f === "miu") return true;
  const ok = existsSync(join(dir, "node_modules", f));
  if (!ok) console.warn(`skipping ${f}: not installed (cd bench && bun install)`);
  return ok;
});

async function start(fw: string) {
  const proc = Bun.spawn(["bun", join(dir, "servers", `${fw}.ts`)], { env: { ...process.env, PORT: "0", NODE_ENV: "production" }, stdout: "pipe", stderr: "inherit" });
  const reader = proc.stdout.getReader();
  let buf = "";
  while (!/LISTENING (\d+)/.test(buf)) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`${fw} server exited before listening`);
    buf += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return { proc, port: Number(/LISTENING (\d+)/.exec(buf)![1]) };
}

async function load(url: string, route: (typeof ROUTES)[number], seconds: number) {
  const per = Math.max(1, Math.round(concurrency / workers));
  const cfg = (c: number) => JSON.stringify({ url, method: route.method, body: route.body, concurrency: c, seconds });
  const procs = Array.from({ length: workers }, () => Bun.spawn(["bun", join(dir, "load.ts"), cfg(per)], { stdout: "pipe", stderr: "inherit" }));
  const outs = await Promise.all(procs.map(async (p) => JSON.parse(await new Response(p.stdout).text()) as { count: number; errors: number }));
  return outs.reduce((a, b) => ({ count: a.count + b.count, errors: a.errors + b.errors }), { count: 0, errors: 0 });
}

const results: Record<string, Record<string, number>> = {};
for (const fw of frameworks) {
  const { proc, port } = await start(fw);
  try {
    for (const route of ROUTES) {
      const url = `http://127.0.0.1:${port}${route.path}`;
      const check = await fetch(url, { method: route.method, body: route.body, headers: route.body ? { "content-type": "application/json" } : undefined });
      const text = await check.text();
      if (check.status !== 200 || text !== route.expect) throw new Error(`${fw} ${route.name}: unexpected ${check.status} ${text}`);
      if (warmup > 0) await load(url, route, warmup);
      const { count, errors } = await load(url, route, duration);
      if (errors) console.warn(`${fw} ${route.name}: ${errors} errors`);
      (results[route.name] ??= {})[fw] = Math.round(count / duration);
      console.error(`${fw.padEnd(7)} ${route.name.padEnd(28)} ${Math.round(count / duration).toLocaleString("en-US")} req/s`);
    }
  } finally {
    proc.kill();
    await proc.exited;
  }
}

const fmt = (n: number | undefined) => (n === undefined ? "–" : n.toLocaleString("en-US"));
const table = [
  `| Route | ${frameworks.join(" | ")} |`,
  `| --- | ${frameworks.map(() => "---:").join(" | ")} |`,
  ...ROUTES.map((r) => `| ${r.name} | ${frameworks.map((f) => fmt(results[r.name]?.[f])).join(" | ")} |`),
].join("\n");

const md = `# MiuJS benchmarks

Requests per second (higher is better). Each framework serves the same three routes on \`Bun.serve\`;
load comes from ${workers} separate Bun processes running ${concurrency} concurrent \`fetch\` loops in total,
${duration}s per route after a ${warmup}s warm-up. Client and server share the machine, so absolute numbers are
bounded by the load generator — compare columns, not against other published benchmarks.

${table}

- Date: ${new Date().toISOString().slice(0, 10)}
- Runtime: Bun ${Bun.version}
- CPU: ${cpus()[0]?.model ?? "unknown"} × ${cpus().length}
- Reproduce: \`cd bench && bun install && bun run.ts --duration ${duration} --concurrency ${concurrency}\`
`;

console.log(`\n${table}\n`);
await writeFile(join(dir, "results.md"), md);
console.log("Wrote bench/results.md");
