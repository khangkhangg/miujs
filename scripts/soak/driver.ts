// Load-driver child process: runs one scenario's virtual clients for a fixed time and prints the
// recorder as JSON on its last stdout line. run.ts starts several of these for high-RPS
// scenarios so the load generator is not the bottleneck.
//   bun scripts/soak/driver.ts <scenario> <port> <ms> <concurrency> [info-json]
import { Recorder } from "./lib.ts";
import { SCENARIOS } from "./scenarios.ts";

const [name, port, ms, conc, infoJson] = process.argv.slice(2);
const sc = SCENARIOS[name];
const rec = new Recorder();
const base = `http://127.0.0.1:${port}`;
const ctx = { base, wsBase: base.replace("http", "ws"), port: Number(port), rec, info: infoJson ? JSON.parse(infoJson) : {} };
const offset = Number(process.env.SOAK_VU_OFFSET ?? 0);
const vus = Array.from({ length: Number(conc) }, (_, i) => sc.vu(ctx, offset + i).catch((e) => rec.err("vu crashed", String(e))));
setTimeout(() => (rec.stopped = true), Number(ms));
await Promise.race([Promise.all(vus), new Promise((r) => setTimeout(r, Number(ms) + 30_000))]);
console.log(
  JSON.stringify({
    all: rec.all.toJSON(),
    ops: Object.fromEntries([...rec.ops].map(([k, h]) => [k, h.toJSON()])),
    errors: Object.fromEntries(rec.errors),
    expected: Object.fromEntries(rec.expected),
    wsFramesIn: rec.wsFramesIn,
    wsFramesOut: rec.wsFramesOut,
  }),
);
process.exit(0);
