// `miu loadtest <ws-url>`: N simulated room clients through @miujs/realtime's loadtest().

import { loadtest, type LoadAction } from "@miujs/realtime/loadtest";
import { CliError, int, parseDuration, str, type CliIO, type Flags } from "./util.ts";

function toAction(v: unknown): LoadAction {
  if (typeof v !== "object" || v === null || typeof (v as { type?: unknown }).type !== "string") {
    throw new CliError("MIU_E_CLI_FLAG_VALUE", `--action ${JSON.stringify(v)} has no "type"`, `Write --action '{"type":"answer","data":{"choice":1}}' (the room message name and its data).`);
  }
  const o = v as { t?: unknown; type: string; data?: unknown };
  if (o.t !== undefined && o.t !== "msg") {
    throw new CliError("MIU_E_CLI_FLAG_VALUE", `--action frame has t "${String(o.t)}"; only "msg" frames are actions`, `Write --action '{"t":"msg","type":"answer","data":{...}}' or just '{"type":"answer","data":{...}}'.`);
  }
  return { type: o.type, data: o.data ?? {} };
}

export function parseActions(text: string): LoadAction[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CliError("MIU_E_CLI_FLAG_VALUE", `--action is not valid JSON: ${text}`, `Quote it for your shell, e.g. --action '{"type":"inc","data":{"by":1}}'.`);
  }
  const list = Array.isArray(parsed) ? parsed.map(toAction) : [toAction(parsed)];
  if (!list.length) throw new CliError("MIU_E_CLI_FLAG_VALUE", "--action is an empty list", "Give at least one action.");
  return list;
}

const ms = (n: number) => `${Math.round(n * 10) / 10} ms`;

export async function cmdLoadtest(io: CliIO, positional: string[], flags: Flags) {
  const url = positional[0];
  if (!url || !/^wss?:\/\//i.test(url)) {
    throw new CliError(
      "MIU_E_CLI_LOADTEST_USAGE",
      url ? `${url} is not a WebSocket URL` : "miu loadtest needs the room's WebSocket URL",
      "Pass a ws:// or wss:// room URL, e.g. `miu loadtest ws://localhost:3000/rooms/quiz/r1 --players 50 --duration 10s --action '{\"type\":\"answer\",\"data\":{\"choice\":1}}'`.",
    );
  }
  const actionText = str(flags, "action");
  // Without --action: a join-only run (players join and stay connected for --duration).
  const actions = actionText ? parseActions(actionText) : [];
  const players = int(flags, "players", 10, 1);
  const durationMs = parseDuration(str(flags, "duration") ?? "10s", "duration");
  const ratePerSecond = int(flags, "rate", 5, 1);

  if (!flags.json) io.out(`Load testing ${url}: ${players} players, ${durationMs} ms, ${actions.length ? `${ratePerSecond} actions/s each` : "join only"}...`);
  const report = await loadtest({ url, players, durationMs, ratePerSecond, actions });
  const failed = report.joined < report.players || report.errors > 0;
  if (flags.json) {
    io.out(JSON.stringify(report, null, 2));
    return failed ? 1 : 0;
  }
  const l = report.latency;
  io.out(`${report.joined}/${report.players} players joined${actions.length ? `, ${report.sent} actions sent, ${report.samples} answered by a state patch` : ""}`);
  const line = (label: string, x: typeof l) => `  ${label.padEnd(8)} p50 ${ms(x.p50)}, p95 ${ms(x.p95)}, p99 ${ms(x.p99)}`;
  io.out(`connect →`);
  io.out(line("welcome", report.welcomeLatency));
  io.out(line("join", report.joinLatency));
  if (actions.length) {
    io.out(`latency (action → next patch):`);
    io.out(`  p50  ${ms(l.p50)}`);
    io.out(`  p95  ${ms(l.p95)}`);
    io.out(`  p99  ${ms(l.p99)}`);
    io.out(`  min ${ms(l.min)}, max ${ms(l.max)}, mean ${ms(l.mean)}`);
  }
  const failures = Object.entries(report.joinFailures);
  if (failures.length) {
    io.out(`join failures:`);
    for (const [reason, n] of failures) io.out(`  ${reason} × ${n}`);
  }
  io.out(`errors ${report.errors}`);
  for (const [code, n] of Object.entries(report.errorCodes)) io.out(`  ${code} × ${n}`);
  if (report.joined < report.players) io.out(`${report.players - report.joined} player(s) did not join: check the URL, the room type and its player limit.`);
  return failed ? 1 : 0;
}
