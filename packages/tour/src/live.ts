// Live guided tours on @miujs/realtime. A guide (who holds the guide token from
// POST /tours/:tour/live) broadcasts the camera; followers join with the 6-digit code as
// spectators and follow, or detach locally. Camera updates reach followers at most 10 times a
// second: the room's per-connection rate limit caps what clients send, and the room itself
// coalesces bursts into one update per 100 ms (`room.schedule`, so it works on Durable Objects).
import { route, t, type Context, type RouteDef } from "miujs";
import { defineRoom, type Player, type Room } from "@miujs/realtime";
import { signTourToken, timingSafeEqual } from "./crypto.ts";
import { tourErrors } from "./errors.ts";
import type { TourRuntime } from "./runtime.ts";
import * as S from "./schemas.ts";
import { loadTour } from "./routes/admin.ts";

export const CAMERA_INTERVAL_MS = 100;

const camera = t.object({ scene: t.string({ maxLength: 100 }), yaw: S.yaw, pitch: S.pitch, fov: S.fov });
const point = t.object({ scene: t.string({ maxLength: 100 }), yaw: S.yaw, pitch: S.pitch });
type Camera = { scene: string; yaw: number; pitch: number; fov: number };

interface LiveState {
  tourId: string;
  guide: { id: string; name: string } | null;
  camera: Camera | null;
  hands: { id: string; name: string; at: number }[];
  followers: number;
}

interface LiveSecret {
  token: string | null;
  lastCameraAt: number;
  pending: Camera | null;
  scheduled: boolean;
}

type LiveRoom = Room<LiveState, LiveSecret>;

const enc = new TextEncoder();

function isGuide(room: LiveRoom, p: Player): boolean {
  return p.role === "host" && room.state.guide?.id === p.id;
}

function requireGuide(room: LiveRoom, p: Player): void {
  if (!isGuide(room, p)) throw tourErrors.guideOnly();
}

function guideInfo(room: LiveRoom) {
  return room.state.guide ? { ...room.state.guide, followers: room.state.followers } : null;
}

function countFollowers(room: LiveRoom): void {
  room.state.followers = room.players.filter((p) => p.connected && p.id !== room.state.guide?.id).length;
}

function sendHands(room: LiveRoom): void {
  if (room.state.guide) room.send(room.state.guide.id, "hands", room.state.hands);
}

function applyCamera(room: LiveRoom, cam: Camera, now: number): void {
  room.secret.lastCameraAt = now;
  room.state.camera = cam;
  room.broadcast("camera", cam, { except: room.state.guide?.id });
}

export const guidedTour = defineRoom("guidedTour", {
  state: t.object({
    tourId: t.string(),
    guide: t.nullable(t.object({ id: t.string(), name: t.string() })),
    camera: t.nullable(camera),
    hands: t.array(t.object({ id: t.string(), name: t.string(), at: t.number() })),
    followers: t.integer({ min: 0 }),
  }),
  client: {
    camera,
    pointer: point,
    raise: t.object({}),
    lower: t.object({}),
    ack: t.object({ playerId: t.string({ maxLength: 64 }) }),
    sync: t.object({}),
    end: t.object({}),
  },
  // ≤10 messages a second per connection (bursts of 20); floods are dropped, then kicked.
  rateLimit: { perSecond: 10, burst: 20 },
  maxMessageBytes: 2048,
  init: ({ data }): LiveState => ({ tourId: String((data as { tourId?: string } | undefined)?.tourId ?? ""), guide: null, camera: null, hands: [], followers: 0 }),
  secret: ({ data }): LiveSecret => ({ token: (data as { guideToken?: string } | undefined)?.guideToken ?? null, lastCameraAt: 0, pending: null, scheduled: false }),
  // The guide token is checked at join (?guide=<token>, or join-frame params): its holder becomes
  // host and guide; everyone else watches as a spectator, so nobody else can take the host seat.
  onJoinRequest: ({ params, player, room }) => {
    const token = params.guide;
    if (token === undefined) {
      player.role = "spectator";
      return;
    }
    const want = room.secret.token;
    if (!want || !timingSafeEqual(enc.encode(token), enc.encode(want))) throw tourErrors.guideToken();
    for (const p of room.players) if (p.role === "host") p.role = "spectator";
    player.role = "host";
    room.state.guide = { id: player.id, name: player.name };
  },
  onJoin: ({ room, player }) => {
    countFollowers(room);
    if (isGuide(room, player)) {
      room.broadcast("guide", guideInfo(room));
      sendHands(room);
    } else {
      room.send(player.id, "guide", guideInfo(room));
      if (room.state.guide) room.send(room.state.guide.id, "guide", guideInfo(room));
    }
    if (room.state.camera) room.send(player.id, "camera", room.state.camera);
  },
  onLeave: ({ room, player }) => {
    room.state.hands = room.state.hands.filter((h) => h.id !== player.id);
    if (room.state.guide?.id === player.id) {
      room.state.guide = null;
      countFollowers(room);
      room.broadcast("guide", null);
      return;
    }
    countFollowers(room);
    sendHands(room);
    if (room.state.guide) room.send(room.state.guide.id, "guide", guideInfo(room));
  },
  on: {
    camera: ({ room, sender, msg, now }) => {
      requireGuide(room, sender);
      const wait = room.secret.lastCameraAt + CAMERA_INTERVAL_MS - now;
      if (wait <= 0 && !room.secret.scheduled) return applyCamera(room, msg, now);
      room.secret.pending = msg;
      if (!room.secret.scheduled) {
        room.secret.scheduled = true;
        room.schedule("flushCamera", Math.max(0, wait));
      }
    },
    pointer: ({ room, sender, msg }) => {
      requireGuide(room, sender);
      room.broadcast("pointer", msg, { except: sender.id });
    },
    raise: ({ room, sender, now }) => {
      if (isGuide(room, sender) || room.state.hands.some((h) => h.id === sender.id)) return;
      room.state.hands = [...room.state.hands, { id: sender.id, name: sender.name, at: now }];
      sendHands(room);
    },
    lower: ({ room, sender }) => {
      room.state.hands = room.state.hands.filter((h) => h.id !== sender.id);
      sendHands(room);
    },
    ack: ({ room, sender, msg }) => {
      requireGuide(room, sender);
      room.state.hands = room.state.hands.filter((h) => h.id !== msg.playerId);
      room.send(msg.playerId, "handAck", {});
      sendHands(room);
    },
    sync: ({ room, sender }) => {
      if (room.state.camera) room.send(sender.id, "camera", room.state.camera);
    },
    end: ({ room, sender }) => {
      requireGuide(room, sender);
      room.broadcast("ended", {});
      room.close("The guide ended the tour");
    },
  },
  timers: {
    flushCamera: ({ room, now }) => {
      const pending = room.secret.pending;
      room.secret.pending = null;
      room.secret.scheduled = false;
      if (pending) applyCamera(room, pending, now);
    },
  },
});

function randomToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(24));
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export function liveRoutes(rt: TourRuntime): RouteDef[] {
  const start = route.post(`${rt.basePath}/:tour/live`, {
    name: "tours_live_start",
    summary: "Start a live guided tour: returns a 6-digit join code, a follow link and a guide link",
    tags: ["tours"],
    permission: "tours:write",
    mcp: false,
    status: 201,
    params: S.tourParams,
    handler: async (c) => {
      const ctx = c as unknown as Context;
      const live = rt.opts.live;
      if (!live) throw tourErrors.liveMissing();
      const { s, tour } = await loadTour(rt, ctx, c.params.tour);
      const guideToken = randomToken();
      const { id, code } = await live.createRoom(guidedTour.type, { data: { tourId: tour.id, guideToken }, env: ctx.env as Record<string, unknown> });
      const view = `${ctx.url.origin}${rt.basePath}/${tour.slug}/view?live=${code}`;
      let followUrl = view;
      if (tour.visibility === "private" || tour.hasPassword) {
        // Followers of a protected tour get a share link that lasts the session.
        const v = await s.tourSecrets(tour.id);
        const e = Math.floor(rt.now() / 1000) + 12 * 3600;
        const share = await signTourToken(rt.secrets(ctx.env, ctx.log), { p: "share", tour: tour.id, v: v!.shareVersion, e });
        followUrl = `${view}&share=${share}`;
      }
      return { roomId: id, code, followUrl, guideUrl: `${followUrl}#guide=${guideToken}` };
    },
  });
  return [start];
}
