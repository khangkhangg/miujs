// Cloudflare transport for matchmaking: one Durable Object per queue, named "match:<queue>"
// (binding MIU_MATCH by default). The Worker's routes authenticate the user and forward
// join/leave/status here; the object keeps the queue (persisted after every change), runs
// matching, creates rooms for matches, and re-runs at the next window widening from an alarm.
// Notify WebSockets are accepted here with the hibernation API, tagged by user id.
//
//   export const MiuMatchmaker = createMatchmakerDurableObject(mm);   // wrangler: binding MIU_MATCH

import { errors, isMiuError, type Env } from "miujs";
import { systemClock, type Clock } from "@miujs/realtime";
import { gameErrors } from "./errors.ts";
import type { Matchmaker, MatchmakerInternals } from "./matchmaker.ts";
import { QueueCore, type QueueEntry, type QueueSnapshot, type QueueStats, type QueueStatus, type QueueTuning, type WaitingView } from "./queue.ts";

export interface NamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(req: Request): Promise<Response> };
}

export interface MatchHost {
  join(queue: string, entry: QueueEntry): Promise<QueueStatus>;
  leave(queue: string, userId: string): Promise<boolean>;
  status(queue: string, userId: string): Promise<QueueStatus>;
}

async function call<T>(ns: NamespaceLike, queue: string, op: string, body: unknown): Promise<T> {
  const url = `https://miu-match/_miu/match/${op}?queue=${encodeURIComponent(queue)}`;
  const res = await ns.get(ns.idFromName(`match:${queue}`)).fetch(new Request(url, { method: "POST", body: JSON.stringify(body) }));
  const json = (await res.json()) as { error?: { code: string; message: string; fix?: string; details?: unknown }; ok?: T };
  if (json.error) throw errors.custom({ code: json.error.code, status: res.status, message: json.error.message, fix: json.error.fix, details: json.error.details });
  return json.ok as T;
}

/** Worker side: queue operations forwarded to the queue's Durable Object. */
export function durableHost(ns: NamespaceLike): MatchHost {
  return {
    join: (queue, entry) => call(ns, queue, "join", entry),
    leave: (queue, userId) => call(ns, queue, "leave", { userId }),
    status: (queue, userId) => call(ns, queue, "status", { userId }),
  };
}

/** Operator calls (matchmaker manage()) forwarded to a queue's Durable Object. */
export interface MatchAdmin {
  inspect(queue: string): Promise<{ stats: QueueStats; tuning: QueueTuning }>;
  entries(queue: string, offset: number, limit: number, search?: string): Promise<{ rows: WaitingView[]; more: boolean }>;
  configure(queue: string, tuning: Partial<QueueTuning>): Promise<QueueTuning>;
}

export function durableAdmin(ns: NamespaceLike): MatchAdmin {
  return {
    inspect: (queue) => call(ns, queue, "inspect", {}),
    entries: (queue, offset, limit, search) => call(ns, queue, "entries", { offset, limit, search }),
    configure: (queue, tuning) => call(ns, queue, "configure", { tuning }),
  };
}

/** The parts of Cloudflare's hibernatable WebSocket used here. */
export interface CfWebSocketLike {
  send(message: string): void;
  close(code?: number, reason?: string): void;
}

export interface DurableStateLike {
  acceptWebSocket(ws: CfWebSocketLike, tags?: string[]): void;
  getWebSockets(tag?: string): CfWebSocketLike[];
  storage: {
    get(key: string): Promise<unknown>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<boolean>;
    setAlarm?(at: number): Promise<void>;
    deleteAlarm?(): Promise<void>;
  };
}

export interface MatchmakerDurableObjectOptions {
  clock?: Clock;
  /** Override `new WebSocketPair()` (tests). Returns [client, server]. */
  webSocketPair?: () => readonly [unknown, CfWebSocketLike];
}

declare const WebSocketPair: { new (): { 0: unknown; 1: CfWebSocketLike } } | undefined;

const SNAP = "miu:queue";
const NAME = "miu:queue:name";
/** Operator overrides of the queue's matching knobs (manage() settings). */
const TUNING = "miu:queue:tuning";

function internals(mm: Matchmaker): MatchmakerInternals {
  return (mm as unknown as Record<symbol, MatchmakerInternals>)[Symbol.for("miujs.game.matchmaker")];
}

function fail(err: unknown): Response {
  if (isMiuError(err)) return err.toResponse();
  console.error("[miujs/game] matchmaker object failed:", err);
  return errors.internal().toResponse();
}

/** An instance of the matchmaker Durable Object (what Cloudflare calls). */
export interface MatchmakerDurableObject {
  fetch(req: Request): Promise<Response>;
  /** Re-run matching (window widened, someone timed out, statuses expired). */
  alarm(): Promise<void>;
  webSocketMessage(ws: CfWebSocketLike, message: string | ArrayBuffer): Promise<void>;
  webSocketClose(): Promise<void>;
}

/** The class createMatchmakerDurableObject() returns; export it from your Worker. */
export interface MatchmakerDurableObjectClass {
  new (state: DurableStateLike, env: unknown): MatchmakerDurableObject;
}

/** Build the Durable Object class that hosts matchmaking queues. Export it from your Worker. */
export function createMatchmakerDurableObject(mm: Matchmaker, opts: MatchmakerDurableObjectOptions = {}): MatchmakerDurableObjectClass {
  const inner = internals(mm);
  const clock = opts.clock ?? inner.clock ?? systemClock;
  const makePair =
    opts.webSocketPair ??
    (() => {
      if (typeof WebSocketPair === "undefined") throw new Error("WebSocketPair is only available on Cloudflare Workers");
      const p = new WebSocketPair();
      return [p[0], p[1]] as const;
    });

  return class MiuMatchmakerDurableObject {
    private state: DurableStateLike;
    private env: Env;
    private core: QueueCore | null = null;
    private armed: number | null | undefined = undefined;

    constructor(state: DurableStateLike, env: unknown) {
      this.state = state;
      this.env = (env ?? {}) as Env;
      inner.useEnv?.(this.env);
    }

    async fetch(req: Request): Promise<Response> {
      try {
        const url = new URL(req.url);
        const op = url.pathname.split("/").pop() ?? "";
        const core = await this.load(url.searchParams.get("queue") ?? "");
        if (op === "notify") return await this.notifySocket(req, core);
        const body = ((await req.json().catch(() => ({}))) ?? {}) as Record<string, any>;
        const now = clock.now();
        switch (op) {
          case "join": {
            const entry: QueueEntry = { userId: String(body.userId), name: String(body.name ?? body.userId), rating: Number(body.rating) };
            if (body.region !== undefined) entry.region = String(body.region);
            core.join(entry, now);
            await this.persist();
            await this.push(core, entry.userId);
            await this.pump(core);
            return Response.json({ ok: await inner.present(core.status(entry.userId, clock.now()), entry.userId) });
          }
          case "leave": {
            const left = core.leave(String(body.userId));
            await this.persist();
            await this.arm(core);
            return Response.json({ ok: left });
          }
          case "status":
            return Response.json({ ok: await inner.present(core.status(String(body.userId), now), String(body.userId)) });
          case "inspect":
            return Response.json({ ok: { stats: core.stats(now), tuning: core.tuning() } });
          case "entries": {
            const limit = Math.max(1, Math.min(100, Math.floor(Number(body.limit)) || 100));
            const offset = Math.max(0, Math.floor(Number(body.offset)) || 0);
            return Response.json({ ok: core.waitingPage(offset, limit, now, typeof body.search === "string" ? body.search : undefined) });
          }
          case "configure": {
            core.configure((body.tuning ?? {}) as Partial<QueueTuning>);
            await this.state.storage.put(TUNING, core.tuning());
            await this.pump(core);
            return Response.json({ ok: core.tuning() });
          }
        }
        return errors.notFound("matchmaker operation", op).toResponse();
      } catch (err) {
        return fail(err);
      }
    }

    /** Alarm: re-run matching (window widened, someone timed out, statuses expired). */
    async alarm(): Promise<void> {
      const name = (await this.state.storage.get(NAME)) as string | undefined;
      if (!name) return;
      this.armed = null;
      await this.pump(await this.load(name));
    }

    async webSocketMessage(ws: CfWebSocketLike, message: string | ArrayBuffer): Promise<void> {
      if (typeof message === "string" && message.includes('"ping"')) ws.send(JSON.stringify({ t: "pong" }));
    }

    async webSocketClose(): Promise<void> {}

    private async load(queue: string): Promise<QueueCore> {
      if (this.core) {
        if (queue && queue !== this.core.name) throw gameErrors.queueUnknown(queue, [this.core.name]);
        return this.core;
      }
      const cfg = Object.prototype.hasOwnProperty.call(inner.queues, queue) ? inner.queues[queue] : undefined;
      if (!cfg) throw gameErrors.queueUnknown(queue, Object.keys(inner.queues));
      const snap = (await this.state.storage.get(SNAP)) as QueueSnapshot | undefined;
      const core = QueueCore.restore(queue, cfg, snap);
      const tuning = (await this.state.storage.get(TUNING)) as QueueTuning | undefined;
      if (tuning) core.configure(tuning);
      this.core = core;
      await this.state.storage.put(NAME, queue);
      return this.core;
    }

    private async persist(): Promise<void> {
      if (this.core) await this.state.storage.put(SNAP, this.core.snapshot());
    }

    private async arm(core: QueueCore): Promise<void> {
      const due = core.nextDue(clock.now());
      if (due === this.armed) return;
      this.armed = due;
      if (due === null) await this.state.storage.deleteAlarm?.();
      else await this.state.storage.setAlarm?.(due);
    }

    private async push(core: QueueCore, userId: string): Promise<void> {
      const sockets = this.state.getWebSockets(userId);
      if (!sockets.length) return;
      const status = await inner.present(core.status(userId, clock.now()), userId);
      const frame = JSON.stringify({ t: "match", queue: core.name, status });
      for (const ws of sockets) {
        try {
          ws.send(frame);
        } catch {}
      }
    }

    /** Run matching; create a room per match (awaited, so the alarm or request finishes it). */
    private async pump(core: QueueCore): Promise<void> {
      const { matches, timedOut } = core.run(clock.now());
      await this.persist();
      for (const u of timedOut) await this.push(core, u);
      for (const m of matches) {
        for (const p of m.players) await this.push(core, p.userId);
        try {
          core.assign(m.id, await inner.createMatch(m, this.env), clock.now());
        } catch (err) {
          console.error(`[miujs/game] creating match ${m.id} failed:`, err);
          core.fail(m.id, m.players.map((p) => p.userId), String((err as Error)?.message ?? err), clock.now());
        }
        await this.persist();
        for (const p of m.players) await this.push(core, p.userId);
      }
      await this.arm(core);
    }

    private async notifySocket(req: Request, core: QueueCore): Promise<Response> {
      const userId = req.headers.get("x-miu-user");
      if (!userId) return errors.unauthorized("The notify socket must come through the Worker route", "Connect to GET /match/:queue/notify, which signs you in and forwards here.").toResponse();
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return errors.custom({ code: "MIU_E_WS_EXPECTED", status: 426, message: "This route only accepts WebSocket connections", fix: "Connect with a WebSocket client." }).toResponse();
      }
      const [client, server] = makePair();
      this.state.acceptWebSocket(server, [userId]);
      server.send(JSON.stringify({ t: "match", queue: core.name, status: await inner.present(core.status(userId, clock.now()), userId) }));
      return new Response(null, { status: 101, webSocket: client } as ResponseInit);
    }
  };
}
