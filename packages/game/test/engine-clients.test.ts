// The Unity client (clients/unity/MiuRealtime.cs) compiled with a local C# compiler, when one
// exists (.NET Framework's csc on Windows, or Mono's mcs): run the protocol vectors, then a live
// session against a real Bun server behind the ticket gate (ticket, play, dropped connection,
// resume, play again).
// Skipped where no compiler is installed. Godot cannot run here; see clients/godot/README.md.

import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { definePlugin, miu } from "miujs";
import { rooms, systemClock, t } from "@miujs/realtime";
import { ticketGate } from "../src/gate.ts";
import { gameRoom, seatOf } from "../src/room.ts";
import { issueTicket } from "../src/sign.ts";

const root = join(import.meta.dir, "..", "..", "..", "clients");
const winCsc = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const compiler = process.platform === "win32" && existsSync(winCsc) ? winCsc : Bun.which("mcs");
const SECRET = "engine-secret-0123456789abcdef";

let exe: string | null = null;
async function build(): Promise<string> {
  if (exe) return exe;
  const out = join(mkdtempSync(join(tmpdir(), "miu-unity-")), "VectorsRunner.exe");
  const proc = Bun.spawn([compiler!, "-nologo", `-out:${out}`, join(root, "unity", "MiuRealtime.cs"), join(root, "unity", "tests", "VectorsRunner.cs")], { stdout: "pipe", stderr: "pipe" });
  const text = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(`C# build failed:\n${text}`);
  expect(text).not.toContain("error");
  return (exe = out);
}

async function run(args: string[]): Promise<{ code: number; out: string }> {
  const cmd = process.platform === "win32" ? [await build(), ...args] : ["mono", await build(), ...args];
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  return { code: await proc.exited, out };
}

test.skipIf(!compiler)("Unity client: compiles warning-free and passes every protocol vector", async () => {
  const r = await run(["vectors", join(root, "protocol-vectors.json")]);
  expect(r.out.trim()).toBe("OK");
  expect(r.code).toBe(0);
}, 60_000);

test.skipIf(!compiler)("Unity client: live ticket, play, dropped connection, resume, play again", async () => {
  const tapper = gameRoom(
    "tapper",
    {
      state: t.object({ taps: t.record(t.number()) }),
      client: { tap: t.object({}) },
      init: () => ({ taps: {} }),
      onSeat: ({ room, seat }) => {
        room.state.taps[seat.userId] = 0;
      },
      on: {
        tap: ({ room, sender }) => {
          room.state.taps[seatOf(room, sender.id)!.userId] += 1;
        },
      },
    },
    { secret: SECRET },
  );
  const realtime = rooms({ rooms: [tapper] });
  // The same pre-upgrade ticket check the matchmaker installs: the client must send ?ticket=.
  const gate = definePlugin({ name: "gate", onRequest: ticketGate({ roomsPath: "/rooms", types: () => ["tapper"], secret: () => SECRET, clock: systemClock }) });
  const app = miu({ plugins: [gate, realtime], logLevel: "silent" });
  const match = { id: "m1", queue: "q", rated: false, players: [{ userId: "u1", name: "Unity", team: 0 }], teams: [["u1"]] };
  const { id } = await realtime.createRoom("tapper", { data: { match } });
  const ticket = await issueTicket(SECRET, { userId: "u1", name: "Unity", roomType: "tapper", roomId: id, matchId: "m1", team: 0 }, Date.now(), 60_000);
  const server = await app.listen(0);
  try {
    const r = await run(["live", `${server.url.replace("http", "ws")}rooms/tapper/${id}`, ticket]);
    const res = JSON.parse(r.out.trim().split("\n").pop()!);
    expect(res).toMatchObject({ ok: true, taps: 2, seatedEvents: 1, resumed: true, reconnecting: 1, sameToken: true, errors: [] });
    expect(res.seat).toEqual({ userId: "u1", name: "Unity", team: 0, matchId: "m1" });
  } finally {
    await server.stop();
  }
}, 60_000);
