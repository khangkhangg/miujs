// bun bench/scenario.ts <scenario-module> --url http://127.0.0.1:3000 [--duration 10] [--concurrency 64] [--workers 2] [--warmup 2] [--out file.md]
import { runScenario } from "./lib/scenario.ts";

const arg = (name: string, def?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1]! : def;
};
const file = process.argv[2];
const url = arg("url");
if (!file || !url) {
  console.error("usage: bun bench/scenario.ts <scenario-module> --url <base-url> [--duration s] [--concurrency n] [--workers n] [--warmup s] [--out file]");
  process.exit(1);
}
const report = await runScenario({
  scenario: new URL(file, `file://${process.cwd()}/`).pathname,
  url,
  duration: Number(arg("duration", "10")),
  concurrency: Number(arg("concurrency", "64")),
  workers: Number(arg("workers", "2")),
  warmup: Number(arg("warmup", "2")),
});
console.log(report.markdown);
const out = arg("out");
if (out) await Bun.write(out, report.markdown + "\n");
