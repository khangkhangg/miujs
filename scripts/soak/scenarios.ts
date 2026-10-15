// Load scenarios, one per example. Each runs `concurrency` virtual clients until `rec.stopped`.
import { connect, type RoomClient } from "../../packages/realtime/src/client.ts";
import { connectMatch, findMatch } from "../../packages/game/src/connect.ts";
import { Recorder, httpClient, rand, sleep, waitFor } from "./lib.ts";

export interface ScenarioCtx {
  base: string;
  wsBase: string;
  port: number;
  rec: Recorder;
  /** Extra values the server wrapper reported (e.g. the seeded CRM org id). */
  info: Record<string, any>;
}

export interface Scenario {
  name: string;
  /** Concurrent virtual clients (full / quick). */
  concurrency: [number, number];
  /** Realtime apps keep empty rooms for reconnect grace + emptyMs (30 s + 30 s). */
  realtime?: boolean;
  vu(ctx: ScenarioCtx, vu: number): Promise<void>;
  /** POST route used by the mid-request disconnect check. */
  abortTarget: { method: string; path: string };
  /** WebSocket path for the mid-socket disconnect check (realtime apps). */
  wsAbortPath?: (ctx: ScenarioCtx, i: number) => Promise<string>;
  /** Extra stuck-handler probe run after the load (returns facts for the report). */
  extraStuck?: (ctx: ScenarioCtx, mem: () => Promise<any>) => Promise<Record<string, unknown>>;
  /** A route that should answer, for cold-start timing. */
  firstRoute: string;
}

let ipSeq = 0;
const freshIp = () => {
  const n = ++ipSeq;
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
};

// ---------------------------------------------------------------------------------------------
// examples/api: register/login, create/list/get/delete notes, cache hits, queue jobs.

const api: Scenario = {
  name: "api",
  concurrency: [32, 16],
  firstRoute: "/notes",
  abortTarget: { method: "POST", path: "/auth/login" },
  async vu({ base, rec }, vu) {
    let gen = 0;
    while (!rec.stopped) {
      gen++;
      const c = httpClient(base, rec, freshIp());
      const email = `u${vu}-${gen}-${rand(1e9)}@soak.test`;
      const password = "soak-password-123";
      const reg = await c.req("POST /auth/register", "/auth/register", { json: { email, password }, expect: [201] });
      if (!reg || reg.status !== 201) {
        await sleep(50);
        continue;
      }
      await c.req("POST /auth/logout", "/auth/logout", { method: "POST" });
      c.ip = freshIp();
      const login = await c.req("POST /auth/login", "/auth/login", { json: { email, password } });
      if (!login || login.status >= 400) continue;
      const notes: string[] = [];
      for (let i = 0; i < 400 && !rec.stopped; i++) {
        const r = Math.random();
        if (r < 0.45) {
          await c.req("GET /notes", "/notes"); // cache hit unless a write just invalidated it
        } else if (r < 0.65) {
          const n = await c.req("POST /notes", "/notes", { json: { title: `note ${i}`, body: "x".repeat(rand(400)) } });
          if (n?.json?.id) notes.push(n.json.id);
          if (notes.length > 10) await c.req("DELETE /notes/:id", `/notes/${notes.shift()}`, { method: "DELETE", expect: [204] });
        } else if (r < 0.8) {
          if (notes.length) await c.req("GET /notes/:id", `/notes/${notes[rand(notes.length)]}`);
          else await c.req("GET /notes/:id (missing)", `/notes/nope`, { expect: [404] });
        } else if (r < 0.9) {
          if (notes.length) await c.req("DELETE /notes/:id", `/notes/${notes.splice(rand(notes.length), 1)[0]}`, { method: "DELETE", expect: [204] });
        } else {
          await c.req("GET /auth/me", "/auth/me");
        }
      }
      for (const id of notes) await c.req("DELETE /notes/:id", `/notes/${id}`, { method: "DELETE", expect: [204] });
      await c.req("POST /auth/logout", "/auth/logout", { method: "POST" });
    }
  },
};

// ---------------------------------------------------------------------------------------------
// examples/quiz: many concurrent games; players join, answer, leave; rooms end.

async function timed<T>(rec: Recorder, op: string, p: Promise<T>): Promise<T | null> {
  const t = performance.now();
  try {
    const v = await p;
    rec.ok(op, performance.now() - t);
    return v;
  } catch (e) {
    rec.err(op, e instanceof Error ? e.message : String(e));
    return null;
  }
}

const quiz: Scenario = {
  name: "quiz",
  concurrency: [40, 20],
  realtime: true,
  firstRoute: "/",
  abortTarget: { method: "POST", path: "/mcp" },
  async wsAbortPath({ base }) {
    const r = await fetch(`${base}/api/games`, { method: "POST", headers: { origin: base } });
    const g = await r.json();
    return `${g.join}?name=Dropper`;
  },
  async vu({ base, wsBase, rec }, vu) {
    const c = httpClient(base, rec, freshIp());
    let game = 0;
    while (!rec.stopped) {
      game++;
      const created = await c.req("POST /api/games", "/api/games", { method: "POST" });
      if (!created?.json?.id) {
        await sleep(100);
        continue;
      }
      if (game % 5 === 1) await c.req("GET /rooms/code/:code", `/rooms/code/${created.json.code}`);
      const url = wsBase + created.json.join;
      const clients: RoomClient[] = [];
      const join = (name: string) => {
        const cl = connect(url, { name, reconnect: false });
        cl.on("state", () => rec.wsFramesIn++);
        cl.on("error", (e: any) => rec.err("ws", e.code));
        clients.push(cl);
        return cl;
      };
      try {
        const host = join("Host");
        if (!(await timed(rec, "ws join (host)", host.ready))) continue;
        const players: RoomClient[] = [];
        const n = 3 + rand(5);
        for (let i = 0; i < n; i++) players.push(join(`P${vu}_${i}`));
        if ((await Promise.all(players.map((p) => timed(rec, "ws join (player)", p.ready)))).some((x) => !x)) continue;
        let t = performance.now();
        host.send("start");
        rec.wsFramesOut++;
        let active = [...players];
        for (let round = 0; round < 5 && !rec.stopped; round++) {
          if (!(await waitFor(() => active.every((p) => p.state?.phase === "question" && p.state.round === round), 25_000))) {
            rec.err("quiz", `round ${round} never opened`);
            break;
          }
          rec.ok("ws broadcast (start/next → question)", performance.now() - t);
          // A late joiner in round 1, who also answers.
          if (round === 1 && Math.random() < 0.5) {
            const late = join(`L${vu}_${game}`);
            if (await timed(rec, "ws join (player)", late.ready)) {
              await waitFor(() => late.state?.phase === "question", 2000);
              active.push(late);
            }
          }
          await Promise.all(
            active.map(async (p) => {
              await sleep(rand(30));
              const me = p.me!.id;
              const t0 = performance.now();
              p.send("answer", { choice: rand(4) });
              rec.wsFramesOut++;
              if (await waitFor(() => p.state?.phase === "reveal" || (p.state?.answered ?? []).includes(me), 25_000)) rec.ok("ws answer → ack", performance.now() - t0);
              else rec.err("quiz", "answer never acknowledged");
            }),
          );
          if (!(await waitFor(() => active.every((p) => p.state?.phase === "reveal"), 25_000))) {
            rec.err("quiz", `round ${round} never revealed`);
            break;
          }
          // In a third of the games someone leaves after the round-3 reveal. Their seat is kept for
          // the 30 s reconnect grace, so round 4 closes on the 20 s question deadline (a room timer).
          if (round === 3 && active.length > 2 && game % 3 === 0) active.pop()!.close();
          t = performance.now();
          host.send("next");
          rec.wsFramesOut++;
        }
        await waitFor(() => host.state?.phase === "done", 5000);
      } finally {
        for (const cl of clients) cl.close();
      }
      await sleep(rand(50));
    }
  },
};

// ---------------------------------------------------------------------------------------------
// examples/crm: list/filter/create/update via the API and the admin UI pages.

const CRM_USERS = ["owner@example.com", "admin@example.com", "sales@example.com"];

const crmScenario: Scenario = {
  name: "crm",
  concurrency: [24, 12],
  firstRoute: "/admin/login",
  abortTarget: { method: "POST", path: "/api/contacts" },
  async vu({ base, rec, info }, vu) {
    const email = CRM_USERS[vu % 3];
    const canDelete = vu % 3 !== 2;
    while (!rec.stopped) {
      const c = httpClient(base, rec, freshIp(), { "x-org-id": info.orgId });
      const login = await c.req("POST /admin/login", "/admin/login", { form: { email, password: "correct horse battery", next: "/admin" }, expect: [303] });
      if (!login || login.status !== 303) {
        await sleep(100);
        continue;
      }
      const mine: string[] = [];
      for (let i = 0; i < 500 && !rec.stopped; i++) {
        const r = Math.random();
        if (r < 0.15) await c.req("GET /api/contacts?stage=", `/api/contacts?stage=${["lead", "qualified", "customer"][rand(3)]}&limit=20`);
        else if (r < 0.25) await c.req("GET /api/contacts?q=", `/api/contacts?q=${["hank", "soak", "peter", "jo"][rand(4)]}&limit=20`);
        else if (r < 0.33) await c.req("GET /api/deals?sort=", `/api/deals?sort=-amount&limit=20`);
        else if (r < 0.43) {
          const n = await c.req("POST /api/contacts", "/api/contacts", { json: { name: `Soak ${vu}-${i}`, email: `s${vu}-${i}-${rand(1e6)}@soak.test`, stage: Math.random() < 0.5 ? "lead" : "qualified" } });
          if (n?.json?.id) mine.push(n.json.id);
          if (canDelete && mine.length > 20) await c.req("DELETE /api/contacts/:id", `/api/contacts/${mine.shift()}`, { method: "DELETE", expect: [200, 204] });
        } else if (r < 0.53) {
          if (mine.length) await c.req("PATCH /api/contacts/:id", `/api/contacts/${mine[rand(mine.length)]}`, { method: "PATCH", json: { stage: ["lead", "qualified", "customer", "lost"][rand(4)], value: rand(100000) } });
        } else if (r < 0.65) await c.req("GET /admin/r/contacts", "/admin/r/contacts");
        else if (r < 0.75) await c.req("GET /admin/r/deals?view=pipeline", "/admin/r/deals?view=pipeline");
        else if (r < 0.85) {
          if (mine.length) await c.req("GET /admin/r/contacts/:id", `/admin/r/contacts/${mine[rand(mine.length)]}`);
        } else if (r < 0.92) await c.req("GET /api/tasks", "/api/tasks?limit=20");
        else await c.req("GET /admin", "/admin");
      }
      if (canDelete) for (const id of mine) await c.req("DELETE /api/contacts/:id", `/api/contacts/${id}`, { method: "DELETE", expect: [200, 204] });
    }
  },
};

// ---------------------------------------------------------------------------------------------
// packages/game/examples/arena: matchmaking and tic-tac-toe games.

const arenaScenario: Scenario = {
  name: "arena",
  concurrency: [80, 40],
  realtime: true,
  firstRoute: "/leaderboards/arena-wins/top?n=5",
  abortTarget: { method: "POST", path: "/match/duel/join" },
  // A client queues alone, starts a long-poll (wait=20000) and vanishes 100 ms later. (One
  // ghost only: two would be matched with each other at once.)
  async extraStuck({ base }, mem) {
    const before = (await mem()).inflight;
    const headers = { authorization: "Bearer guest:ghost", "content-type": "application/json", "x-soak-ip": freshIp() };
    await fetch(`${base}/match/duel/join`, { method: "POST", headers, body: "{}" }).then((r) => r.arrayBuffer());
    const ac = new AbortController();
    const p = fetch(`${base}/match/duel/status?wait=20000`, { headers, signal: ac.signal }).catch(() => null);
    setTimeout(() => ac.abort(), 100);
    await p;
    await sleep(2000);
    const at2s = (await mem()).inflight;
    await sleep(19_000);
    const at21s = (await mem()).inflight;
    await fetch(`${base}/match/duel/leave`, { method: "DELETE", headers }).catch(() => null);
    return { longPollAborted: 1, inflightBefore: before, inflight2sAfterAbort: at2s, inflight21sAfterAbort: at21s };
  },
  async vu({ base, wsBase, rec }, vu) {
    const name = `p${vu}`;
    const headers = { authorization: `Bearer guest:${name}`, "x-soak-ip": freshIp() };
    const timedFetch: typeof fetch = (async (input: any, init?: any) => {
      const t = performance.now();
      const u = String(input);
      const op = u.includes("/join") ? "POST /match/duel/join" : "GET /match/duel/status (long-poll)";
      const r = await fetch(input, init);
      if (r.ok) rec.ok(op, performance.now() - t);
      else rec.err(op, `HTTP ${r.status}`);
      return r;
    }) as typeof fetch;
    while (!rec.stopped) {
      const t = performance.now();
      let m;
      try {
        m = await findMatch(base, "duel", { headers, waitMs: 5000, timeoutMs: 60_000, fetch: timedFetch });
      } catch (e: any) {
        if (!rec.stopped) rec.err("matchmaking", e.code ?? e.message);
        await sleep(200);
        continue;
      }
      rec.ok("matchmaking (join → matched)", performance.now() - t);
      const { room, seated } = connectMatch(wsBase + m.room.url, m.ticket, { name, reconnect: false });
      room.on("error", (e: any) => rec.err("ws", e.code));
      room.on("state", () => rec.wsFramesIn++);
      try {
        const seat = await timed(rec, "ws join + ticket → seated", seated);
        if (!seat) continue;
        const me = seat.userId;
        let pending = -1;
        let movedAt = 0;
        const over = () => room.state?.phase === "over";
        const deadline = Date.now() + 30_000;
        while (!over() && Date.now() < deadline) {
          const s = room.state;
          if (pending !== -1 && s.board[pending] !== "") {
            rec.ok("ws move → board update", performance.now() - movedAt);
            pending = -1;
          }
          if (pending === -1 && s?.phase === "playing" && s.marks[me] === s.turn) {
            const empty = s.board.map((c: string, i: number) => (c === "" ? i : -1)).filter((i: number) => i >= 0);
            pending = empty[rand(empty.length)];
            movedAt = performance.now();
            room.send("move", { cell: pending });
            rec.wsFramesOut++;
          }
          await sleep(2);
        }
        if (!over()) rec.err("arena", "game did not finish in 30 s");
        else rec.ok("game (seated → over)", performance.now() - t);
      } finally {
        room.close();
      }
    }
  },
};

// ---------------------------------------------------------------------------------------------
// Bare core app: JSON routes at high RPS. Run from driver processes (see run.ts --drivers).

const core: Scenario = {
  name: "core",
  concurrency: [64, 64],
  firstRoute: "/json",
  abortTarget: { method: "POST", path: "/echo" },
  async vu({ base, rec }) {
    const json = `${base}/json`;
    while (!rec.stopped) {
      const r = Math.random();
      const t = performance.now();
      try {
        let res: Response;
        let op: string;
        if (r < 0.8) {
          op = "GET /json";
          res = await fetch(json);
        } else if (r < 0.95) {
          op = "GET /users/:id";
          res = await fetch(`${base}/users/${rand(1000)}`);
        } else {
          op = "POST /echo";
          res = await fetch(`${base}/echo`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"name":"tea","qty":2}' });
        }
        await res.arrayBuffer();
        if (res.status === 200) rec.ok(op, performance.now() - t);
        else rec.err(op, `HTTP ${res.status}`);
      } catch (e) {
        rec.err("core", e instanceof Error ? e.message : String(e));
      }
    }
  },
};

export const SCENARIOS: Record<string, Scenario> = { api, quiz, crm: crmScenario, arena: arenaScenario, core };
