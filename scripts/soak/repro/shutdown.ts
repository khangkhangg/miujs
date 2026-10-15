// Graceful-shutdown reproductions with the shared exitCheck harness: each script starts an example
// with app.listen(0), does a little real work over HTTP/WebSockets, then calls server.stop() and
// app.drain(), and must exit on its own within 3 s.
//
//   bun scripts/soak/repro/shutdown.ts
import { exitCheck } from "../../lib/leak.ts";

const pre = `
const server = await app.listen(0, "127.0.0.1");
const base = server.url.replace(/\\/$/, "");
const ws = base.replace("http", "ws");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error("timeout"); await sleep(5); } }
`;
const post = `
await server.stop();
await app.drain();
console.error("stopped at", Math.round(performance.now()));
`;

const cases: Record<string, string> = {
  "core: a few requests": `
import { createCoreApp } from "../scripts/soak/core-app.ts";
const app = createCoreApp();
${pre}
for (let i = 0; i < 10; i++) await (await fetch(base + "/json")).text();
${post}`,

  "api: register + create note (queue job)": `
import { createApp } from "../examples/api/app.ts";
const { app } = createApp({ sessionSecret: "x".repeat(48), passwordIterations: 1000 });
${pre}
const h = { "content-type": "application/json", origin: base };
const r = await fetch(base + "/auth/register", { method: "POST", headers: h, body: JSON.stringify({ email: "a@b.test", password: "password-123" }) });
const cookie = r.headers.getSetCookie()[0].split(";")[0];
await (await fetch(base + "/notes", { method: "POST", headers: { ...h, cookie }, body: JSON.stringify({ title: "t" }) })).text();
await (await fetch(base + "/notes", { headers: { ...h, cookie } })).text();
${post}`,

  "crm: seed + login + create contact (workflow)": `
import { createApp } from "../examples/crm/app.ts";
import { seed } from "../examples/crm/seed.ts";
const made = createApp({ sessionSecret: "x".repeat(48), passwordIterations: 1000 });
const app = made.app;
const out = await seed(app, made.database, { password: "correct horse battery" });
${pre}
const login = await fetch(base + "/admin/login", { method: "POST", redirect: "manual", headers: { origin: base, "content-type": "application/x-www-form-urlencoded" }, body: "email=owner%40example.com&password=correct+horse+battery&next=%2Fadmin" });
const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
await (await fetch(base + "/api/contacts", { method: "POST", headers: { origin: base, cookie, "x-org-id": out.org.id, "content-type": "application/json" }, body: JSON.stringify({ name: "Lead", stage: "lead" }) })).text();
${post}`,

  "quiz: game created, nobody joined": `
import app from "../examples/quiz/app.ts";
${pre}
await (await fetch(base + "/api/games", { method: "POST", headers: { origin: base } })).text();
${post}`,

  "quiz: game finished, everyone left": `
import app from "../examples/quiz/app.ts";
import { connect } from "../packages/realtime/src/client.ts";
${pre}
const g = await (await fetch(base + "/api/games", { method: "POST", headers: { origin: base } })).json();
const host = connect(ws + g.join, { name: "Host", reconnect: false }); await host.ready;
const p = connect(ws + g.join, { name: "Ann", reconnect: false }); await p.ready;
host.send("start");
for (let r = 0; r < 5; r++) {
  await until(() => p.state?.phase === "question" && p.state.round === r);
  p.send("answer", { choice: 0 });
  await until(() => p.state?.phase === "reveal");
  host.send("next");
}
await until(() => p.state?.phase === "done");
host.close(); p.close();
await sleep(50);
${post}`,

  "quiz: question open (20 s deadline timer), everyone left": `
import app from "../examples/quiz/app.ts";
import { connect } from "../packages/realtime/src/client.ts";
${pre}
const g = await (await fetch(base + "/api/games", { method: "POST", headers: { origin: base } })).json();
const host = connect(ws + g.join, { name: "Host", reconnect: false }); await host.ready;
const p = connect(ws + g.join, { name: "Ann", reconnect: false }); await p.ready;
host.send("start");
await until(() => p.state?.phase === "question");
host.close(); p.close();
await sleep(50);
${post}`,

  "arena: matchmaking only (status long-poll answered)": `
import app from "../packages/game/examples/arena/app.ts";
import { findMatch } from "../packages/game/src/connect.ts";
${pre}
await Promise.all(["ann", "bob"].map((n) => findMatch(base, "duel", { headers: { authorization: "Bearer guest:" + n }, waitMs: 2000 })));
${post}`,

  "arena: full game played, both left": `
import app from "../packages/game/examples/arena/app.ts";
import { findMatch, connectMatch } from "../packages/game/src/connect.ts";
${pre}
const ms = await Promise.all(["ann", "bob"].map((n) => findMatch(base, "duel", { headers: { authorization: "Bearer guest:" + n }, waitMs: 2000 })));
const cs = ms.map((m, i) => connectMatch(ws + m.room.url, m.ticket, { name: ["ann", "bob"][i], reconnect: false }));
const seats = await Promise.all(cs.map((c) => c.seated));
const x = cs[seats[0].team === 0 ? 0 : 1], o = cs[seats[0].team === 0 ? 1 : 0];
await until(() => x.room.state?.phase === "playing");
for (const [c, cell] of [[x, 0], [o, 3], [x, 1], [o, 4], [x, 2]]) { c.room.send("move", { cell }); await until(() => x.room.state.board[cell] !== ""); }
await until(() => o.room.state.phase === "over");
for (const c of cs) c.room.close();
await sleep(50);
${post}`,
};

const only = process.argv[2];
console.log("| Case | Exits within 3 s? | Time to exit |");
console.log("| --- | --- | ---: |");
for (const [name, src] of Object.entries(cases)) {
  if (only && !name.startsWith(only)) continue;
  const r = await exitCheck(src, Number(process.env.EXIT_LIMIT_MS ?? 3000));
  const err = r.stderr.split("\n").filter((l) => l && !l.startsWith("stopped at") && !/MiuJS listening/.test(l)).slice(-2).join(" ");
  console.log(`| ${name} | ${r.exited ? (r.code === 0 ? "yes" : `exited with code ${r.code}`) : "**no**"} | ${r.exited ? `${r.ms.toFixed(0)} ms` : `> ${(Number(process.env.EXIT_LIMIT_MS ?? 3000) / 1000).toFixed(0)} s (killed)`} |${err ? ` ${err.slice(0, 200)}` : ""}`);
}
