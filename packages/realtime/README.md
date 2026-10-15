# @miujs/realtime

> Server-authoritative realtime rooms over WebSockets for MiuJS, with state patches, timers, join codes, shards, Durable Objects and a client SDK.

`@miujs/realtime` runs multiplayer rooms (games, quizzes, chat, live dashboards) where the server owns the state. You define a room type with a state schema, typed client messages and handlers; every state change is sent to clients as a JSON patch. Rooms live in memory on Bun, Deno and Node, and one Durable Object per room on Cloudflare Workers. Use it when clients must not be trusted with the game logic or hidden state.

## Install

```bash
bun add @miujs/realtime miujs
```

Bun runs the TypeScript source; Node and Deno get prebuilt JS with `.d.ts` types (npm packages are not published yet).

## Quick start

<!-- test -->
```ts
import { miu } from "miujs";
import { defineRoom, rooms, t } from "@miujs/realtime";

export const chat = defineRoom("chat", {
  state: t.object({ lines: t.array(t.string()) }),
  client: { say: t.object({ text: t.string() }) },
  init: () => ({ lines: [] }),
  on: {
    say: ({ room, sender, msg }) => {
      room.state.lines = [...room.state.lines, `${sender.name}: ${msg.text}`];
    },
  },
});

// WebSocket endpoint: ws://localhost:3000/rooms/chat/<id>?name=Ann
const app = miu({ name: "chat", plugins: [rooms({ rooms: [chat] })], mcp: true });
export default app;
```

The first non-spectator to join a room becomes the host. Handlers mutate `room.state`; after each handler the new state is checked against the `state` schema (bad changes roll back) and a patch goes to every client. With `mcp: true`, agents get the `rooms_list` and `room_state` tools.

## Rooms

A room definition can also hold server-only state, per-player views, join/leave hooks and named timers.

<!-- test -->
```ts
import { defineRoom, t } from "@miujs/realtime";

export const guess = defineRoom("guess", {
  state: t.object({ phase: t.enum(["open", "closed"]), winner: t.nullable(t.string()) }),
  secret: () => ({ number: Math.floor(Math.random() * 100) }), // never sent to clients
  client: { guess: t.object({ n: t.integer({ min: 0, max: 99 }) }) },
  init: () => ({ phase: "open" as const, winner: null }),
  timers: {
    close: ({ room }) => {
      room.state.phase = "closed";
    },
  },
  onJoin: ({ room, player }) => {
    if (player.role === "host") room.schedule("close", 60_000);
  },
  on: {
    guess: ({ room, sender, msg }) => {
      if (room.state.phase !== "open") return;
      if (msg.n === room.secret.number) {
        room.state.winner = sender.name;
        room.state.phase = "closed";
        room.broadcast("won", { name: sender.name });
      } else {
        room.send(sender.id, "hint", { higher: msg.n < room.secret.number });
      }
    },
  },
  maxPlayers: 20,
});
```

The `room` handle offers `state`, `secret`, `players`, `player(id)`, `broadcast(event, data, { except, to })`, `send(playerId, event, data)`, `schedule(name, delayMs, data)` / `cancel(timerId)`, `after(ms, fn)`, `tick(hz, fn)`, `now()`, `storage` and `close(reason)`. Named timers (`schedule`) are persisted and survive Durable Object hibernation; `after` and `tick` are closures and only work in local rooms. A `view(state, player)` function sends each player their own view of the state (hidden hands, fog of war).

### Large rooms

Joins and leaves are cheap by default. The state changes they cause (`onJoin`, `onLeave`, kicks, grace expiry) reach the other members as one patch per `presenceBatchMs` window (default 50 ms; the first change after a quiet period goes out at once). A joiner's first `state` always includes their own join, and a message, timer or event flushes pending changes first, so ordering holds. Seating N players therefore sends about N frames per window instead of a patch to everyone per join (N²/2 frames). `presenceBatchMs: 0` patches everyone on every join and leave, as before.

To stop broadcasting presence at all, keep the roster out of what players see: a `view` that gives the host the whole state and each player only their own row means a join changes the host's view and nobody else's. `examples/quiz` does this. Seating 1,000 players there sends about 2,000 frames instead of 500,000.

## Client SDK

`@miujs/realtime/client` works anywhere with a `WebSocket` (browsers, Bun, Deno, Node 22+). It applies patches, reconnects with a resume token and queues messages while reconnecting.

<!-- test -->
```ts
import { connect } from "@miujs/realtime/client";

const room = connect<{ lines: string[] }>("ws://localhost:3000/rooms/chat/lobby", { name: "Ann" });
await room.ready;
console.log(room.me?.role, room.state?.lines);
room.on("state", (state: { lines: string[] }) => console.log(state.lines));
room.send("say", { text: "hi" });
```

Built-in events: `state`, `welcome`, `error`, `open`, `close`, `reconnecting`, `reconnected`; other names are server `broadcast`/`send` events. Framework bindings are in subpath exports and take your framework as an argument (no dependency):

```ts
import * as React from "react";
import { createUseRoom } from "@miujs/realtime/react";

export const useRoom = createUseRoom(React);
// const { state, me, status, error, send } = useRoom(url, { name: "Ann" });
```

- `@miujs/realtime/vue`: `useRoom(url, { name, shallowRef, onScopeDispose })` returns refs.
- `@miujs/realtime/svelte`: `roomStore(url, { name })` is a readable store (`$room.state`).
- `@miujs/realtime/msgpack`: `encode` / `decode`; pass `encoding: "msgpack"` to `connect` for binary frames.
- `@miujs/realtime/loadtest`: `loadtest({ url, players, durationMs, actions })` reports latency percentiles.

Other languages (Unity, Godot, Swift) can join using the [wire protocol](./PROTOCOL.md).

## Join codes

`rooms()` returns a plugin with `createRoom(type, { data })`, which creates a room and a 6-digit code. Pass `{ code: false }` for rooms reached by id only, such as matchmaker rooms. The plugin's route prefix is available as `realtime.path`. Clients resolve the code with `GET /rooms/code/:code` and then connect to the room id.

<!-- test -->
```ts
import { miu, route } from "miujs";
import { defineRoom, rooms, t } from "@miujs/realtime";

const lobby = defineRoom("lobby", {
  state: t.object({ title: t.string() }),
  init: (ctx) => ({ title: (ctx.data as { title?: string } | undefined)?.title ?? "Lobby" }),
});

const realtime = rooms({ rooms: [lobby], codes: "ROOM_CODES" }); // KV binding on Workers

export const createGame = route.post("/api/games", {
  summary: "Create a lobby and its join code",
  handler: async () => {
    const { id, code } = await realtime.createRoom("lobby", { data: { title: "Friday quiz" } });
    return { id, code, join: `/rooms/lobby/${id}` };
  },
});

export default miu({ name: "games", routes: [createGame], plugins: [realtime] });
```

Code lookups are rate limited per IP. Without the `codes` KV binding, codes live in memory (per isolate on Workers).

## Shards

`shardedRoom` splits one logical room into shards of at most `shardSize` players, with a coordinator that aggregates across shards (for example a global leaderboard).

<!-- test -->
```ts
import { defineRoom, rooms, shardedRoom, t } from "@miujs/realtime";

const battle = defineRoom("battle", {
  state: t.object({ scores: t.record(t.number()), top: t.array(t.number()) }),
  client: { score: t.object({ n: t.number() }) },
  init: () => ({ scores: {}, top: [] }),
  on: {
    score: ({ room, sender, msg }) => {
      room.state.scores[sender.id] = (room.state.scores[sender.id] ?? 0) + msg.n;
    },
  },
});

export const arena = shardedRoom(battle, {
  shardSize: 100,
  aggregate: (shards) => shards.flatMap((s) => Object.values(s.state.scores)).sort((a, b) => b - a).slice(0, 10),
  publish: ({ room, aggregate }) => {
    room.state.top = aggregate;
  },
});

export const realtime = rooms({ rooms: [arena] }); // /rooms/battle/finals → shards finals:shard0, ...
```

## Durable Objects

On Cloudflare each room is a Durable Object named `type:id`. Export the class built from the same room types you pass to `rooms()`:

<!-- test -->
```ts
import { miu } from "miujs";
import { createRoomDurableObject, defineRoom, rooms, t } from "@miujs/realtime";

const chat = defineRoom("chat", {
  state: t.object({ lines: t.array(t.string()) }),
  init: () => ({ lines: [] }),
});

export const MiuRooms = createRoomDurableObject([chat]); // bound as MIU_ROOMS
export default miu({ name: "chat", plugins: [rooms({ rooms: [chat] })] });
```

The object uses the WebSocket hibernation API. State, players, resume tokens and named timers are persisted to Durable Object storage, and an alarm wakes the object for the next timer.

Persistence is coalesced and split:

- **Coalesced.** The first change after a quiet period is written at once. Later changes are written at most once per `persistMs` (default 1000 ms). A pending write keeps the object awake, so it cannot hibernate with unwritten state. New or cancelled timers, alarms, the last socket closing, `createRoom` and operator actions are always written at once. A crash or redeploy can lose at most one window. `persistMs: 0` writes after every event.
- **Split.** Game state, members and `secret` are stored apart, and a section is only rewritten when it changed. A message that changes the state does not rewrite the member list. Sections over 16 KB are split into 60 000-character chunks (under the 128 KiB per-value limit of KV-backed objects; SQLite-backed objects allow 2 MB). The room size is therefore no longer capped by one value. Chunks are written before the header that points to them, so a crash mid-write leaves the previous snapshot readable. Snapshots stored by older versions (one key) still load.
- **Never silent.** A snapshot bigger than `maxSnapshotBytes` (default 16 MiB) is not written (`MIU_E_ROOM_STATE_TOO_LARGE`). A failed storage write is logged as `MIU_E_ROOM_PERSIST_FAILED` and retried after `persistMs`. Both are counted, and the room keeps running from memory. The admin action `roomStorage` shows the last snapshot size, write counts and failures.

## Options

`rooms(options)`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `rooms` | `RoomType[]` | required | Room types served by this plugin. |
| `path` | `string` | `"/rooms"` | Route prefix: `GET {path}/:type/:id` and `GET {path}/code/:code`. |
| `binding` | `string` | `"MIU_ROOMS"` | Durable Object namespace binding on Cloudflare. |
| `className` | `string` | `"MiuRooms"` | Exported Durable Object class name (for `miu deploy cloudflare`). |
| `codes` | `string` | none (memory) | KV binding for join codes on Cloudflare. |
| `codeTtlMs` | `number` | `21600000` (6 h) | How long a join code stays valid. |
| `codeLookups` | `{ perMinute?, burst? }` | `{ perMinute: 30, burst: 10 }` | Per-IP limit on wrong join codes (only misses count, so a classroom behind one NAT can all look up the real code). |
| `maxConnectionsPerIp` | `number` | `1000` | Open room sockets per client IP (Bun/Deno/Node); more get `429 MIU_E_ROOM_TOO_MANY_CONNECTIONS`. |
| `mcpAccess` | `"admin" | "public"` | `"admin"` | Who may call the MCP tools `rooms_list` / `room_state` (they list every room id and show raw state, bypassing join codes and `view`). |
| `emptyMs` | `number` | `30000` | Dispose local rooms after they stay empty this long. |
| `clock` | `Clock` | `systemClock` | Time source (`FakeClock` in tests). |

`defineRoom(type, definition)`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `state` | `Schema` | required | State every client sees; checked after each handler. |
| `init` | `(ctx) => state` | required | Initial state; `ctx.data` is the `createRoom` data. |
| `client` | `Record<string, Schema>` | none | Messages clients may send, validated before handlers run. |
| `on` | handlers by message type | none | `({ room, sender, msg, now })` per client message. |
| `secret` | `(ctx) => X` | none | Server-only state. |
| `onJoin` / `onLeave` | `({ room, player, now })` | none | Join and leave hooks. |
| `view` | `(state, player) => unknown` | none | Per-player view of the state. |
| `timers` | `Record<string, fn>` | none | Named handlers for `room.schedule()`. |
| `rateLimit` | `{ perSecond?, burst?, kickAfterMs? } \| false` | `30/s`, burst `60`, kick after `3000` ms | Inbound frame limit per connection. |
| `maxMessageBytes` | `number` | `16384` | Largest inbound frame; bigger frames close the socket (1009). |
| `maxPlayers` | `number` | unlimited | Max non-spectator players. |
| `maxMembers` | `number` | `5000` | Max seats of any role, spectators included. |
| `joinTimeoutMs` | `number` | `10000` | A socket that has not joined by then is closed (4002). `0` turns it off. |
| `requireHostKey` | `boolean` | `false` | Host only with the `hostKey` that `createRoom()` returns: nobody is host by joining first, and nobody is promoted when the host leaves. Use it when the host has powers. |
| `createOnJoin` | `boolean` | `true` | `false`: only rooms made with `createRoom()` exist; any other id is `404 MIU_E_ROOM_NOT_FOUND` (no rooms conjured by random URLs). |
| `patchBatchMs` | `number` | `0` | Coalesce the patches of messages and timers into one per window (the first at once). For real-time games: 16-50 ms turns M moves × N players frames into ~N per window. |
| `reconnectMs` | `number` | `30000` | How long a disconnected player keeps their seat. |
| `presenceBatchMs` | `number` | `50` | Coalesce the patches caused by joins and leaves into one per window. `0` sends them at once. |

The `room` handle also has `room.kick(playerId, code?)` and `room.env`.

- `room.kick` removes the seat at once: no reconnect grace, resume token revoked, `onLeave` runs. The socket closes with `code`, default `4009`, which clients treat as terminal.
- `room.env` is the Durable Object's `env` on Workers (D1 and other bindings) and the process env locally.

Security notes:

- `createRoom()` returns `{ id, code, hostKey }`. Hand the `hostKey` to the creator only; with `requireHostKey: true` it is the only way to be host.
- `onLeave` gets `kicked: true` for `room.kick()`, so a room can keep its own ban list.
- A client that closes cleanly (code 1000, `room.close()` in the SDK) leaves at once: no reconnect grace.
- A socket the runtime had to drop frames for (Bun: past its backpressure limit, a client that stopped reading) is closed with 1013 and resumes with a fresh state, instead of silently missing patches.
- Handler crashes reach the client as `MIU_E_ROOM_HANDLER_FAILED` without the internal message.

`connect(url, options)` from `@miujs/realtime/client`: `name`, `role` (default `"player"`), `hostKey`, `resume`, `reconnect` (default on: `minDelayMs` 250, `maxDelayMs` 5000, `maxAttempts` Infinity; `false` turns it off), `encoding` (`"json"` or `"msgpack"`, default `"json"`), `WebSocket` (default: the global one).

`shardedRoom(room, options)`: `shardSize` (required), `maxShards` (default `64`), `aggregate(shards)`, `publish({ room, aggregate })`. `createRoomDurableObject(types, options)`: `binding` (default `"MIU_ROOMS"`), `clock`, `persistMs` (default `1000`; `0` writes after every event), `maxSnapshotBytes` (default 16 MiB), `onError(err, where)` (default `console.error`) for persistence failures.

## Errors

- `MIU_E_ROOM_TYPE_INVALID`: `defineRoom` got a type name that is not 1-64 letters, digits, `_` or `-`.
- `MIU_E_ROOM_HANDLER_UNKNOWN`: `on.<name>` has no matching `client.<name>` schema.
- `MIU_E_ROOM_TYPE_UNKNOWN`: the URL names a room type that is not registered (404).
- `MIU_E_ROOM_ID_INVALID`: the room id is not 1-64 letters, digits, `_` or `-` (400).
- `MIU_E_ROOM_MESSAGE_INVALID`: a client message failed its schema.
- `MIU_E_ROOM_STATE_INVALID`: a handler left the state invalid; the change was rolled back.
- `MIU_E_ROOM_FULL`: the room (or every shard) has `maxPlayers` seated, or `maxMembers` seats of any role.
- `MIU_E_ROOM_NOT_FOUND`: `createOnJoin: false` and no such room (404).
- `MIU_E_ROOM_TOO_MANY_CONNECTIONS`: this IP holds `maxConnectionsPerIp` room sockets (429).
- `MIU_E_ROOM_JOIN_TIMEOUT`: the socket did not join within `joinTimeoutMs` (closed 4002).
- `MIU_E_ROOM_RATE_LIMITED`: a client sent frames over the rate limit.
- `MIU_E_ROOM_CODE_UNKNOWN` / `MIU_E_ROOM_CODE_RATE_LIMITED`: join code not found, or too many lookups.
- `MIU_E_ROOM_TIMER_NOT_DURABLE`: `after()` or `tick()` was used in a Durable Object; use `schedule()`.
- `MIU_E_ROOM_SHARD_SIZE`: `shardedRoom` got a bad `shardSize`.
- `MIU_E_ROOM_STATE_TOO_LARGE`: a Durable Object room's snapshot is over `maxSnapshotBytes`. It is not written; the room keeps running from memory.
- `MIU_E_ROOM_PERSIST_FAILED`: Durable Object storage refused a snapshot write. It is logged, counted and retried.
- `MIU_E_ROOM_SNAPSHOT_CORRUPT`: a stored snapshot chunk is missing. Close the room to start over.
- `MIU_E_WS_EXPECTED`: plain HTTP request to the WebSocket URL (426).

See [all error codes](../../docs/errors.md), e.g. [`MIU_E_ROOM_FULL`](../../docs/errors.md#miu_e_room_full).

## Cloudflare Workers

- **Durable Objects:** one object per room, binding `MIU_ROOMS` (option `binding`), class `MiuRooms` (option `className`). Export `createRoomDurableObject([...])` under that class name.
- **KV:** optional, for join codes (option `codes`). Without it, codes are per isolate.
- Without the Durable Object binding on Workers, rooms fall back to in-isolate memory and log a warning; they are not shared across isolates.

`miu deploy cloudflare` writes these bindings from the plugin. The shape:

```toml
[[kv_namespaces]]
binding = "ROOM_CODES"

[[durable_objects.bindings]]
name = "MIU_ROOMS"
class_name = "MiuRooms"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["MiuRooms"]
```

On Bun, Deno and Node rooms run in process (`LocalRooms`); nothing else is needed.

## Admin

`rooms()` implements `manage()`, so `@miujs/admin` shows a **Realtime rooms** section:

- **Status**: live rooms, connected sockets, members (and rooms) in reconnect grace, and a per-type table. These count rooms in this process; on Cloudflare every room is its own Durable Object, which a Worker cannot list, so the numbers cover only the current isolate (normally 0) and say so.
- **List** `rooms`: type, id, members, connected, in grace, age and a truncated preview of the public state (never `secret`, resume tokens or host keys). Filter by type, search by id. Empty on Cloudflare.
- **Row actions**: `broadcast` (`{ event, message? }`), `kick` (`{ member }`, danger) and `close` (`{ reason? }`, danger).
- **Actions** `broadcastRoom`, `kickMember`, `closeRoom`: the same, by `type` and `id`. On Cloudflare they are forwarded to the room's Durable Object, so they work there too. Closing a room that is not open, or kicking a member who already left, is a no-op with a message.
- **Action** `roomStorage` (`{ type, id }`): a Durable Object room's last persisted snapshot size and key count, writes, unchanged skips, failures and the last error. In-process rooms are not persisted, and the action says so.

## Links

- [Getting started guide](../../docs/guide.md)
- [Error codes](../../docs/errors.md)
- [AGENTS.md](../../AGENTS.md)
- [Wire protocol](./PROTOCOL.md)
- [Quiz example](../../examples/quiz)
- [Source](./src)
- [Tests](./test)
- Related: [@miujs/workflows](../workflows/README.md), [@miujs/files](../files/README.md)
