# @miujs/game

The game kit for MiuJS, built on `@miujs/realtime` rooms. It provides:

- matchmaking with widening rating windows
- private lobbies with join codes
- player profiles and Elo / Glicko-2-lite ratings
- leaderboards with periodic resets
- achievements
- tick-loop, interpolation and input helpers
- Unity and Godot clients

It runs locally in memory with SQLite, and on Cloudflare with Durable Objects and D1.

```ts
import { miu, t } from "miujs";
import { rooms } from "@miujs/realtime";
import { defineAchievements, gameRoom, leaderboard, matchmaker, profiles, reportResult, seatOf } from "@miujs/game";

const achievements = defineAchievements({ firstWin: { title: "First win", check: (s) => s.wins >= 1 } });
const wins = leaderboard({ id: "wins", sort: "desc", resets: "weekly", mode: "sum", maxScore: 1 });

const arena = gameRoom("arena", {
  state: t.object({ /* ... */ }),
  client: { move: t.object({ cell: t.integer({ min: 0, max: 8 }) }) },
  init: ({ match }) => ({ /* match.players: [{ userId, name, team }] */ }),
  onSeat: ({ room, seat }) => { /* seat.userId presented a valid ticket */ },
  on: {
    move: async ({ room, sender, msg }) => {
      const me = seatOf(room, sender.id)!.userId;
      // ... decide the game server-side, then:
      await reportResult(room, { winners: [me] });    // ratings, stats, achievements (once per match)
      await wins.submit(me, 1);                         // trusted: comes from the room
    },
  },
});

const realtime = rooms({ rooms: [arena] });
const mm = matchmaker({
  rooms: realtime,
  achievements,
  queues: { ranked: { room: "arena", teamSize: 1, teams: 2, rating: "elo", widenAfterMs: 5_000, maxWaitMs: 120_000 } },
});
export default miu({ plugins: [auth /* your auth plugin, e.g. @miujs/auth */, realtime, mm, wins, profiles({ achievements })], mcp: true });
```

`examples/arena` is a complete, tested example: ranked tic-tac-toe.

## Matchmaking: `matchmaker({ rooms, queues, ... })`

| Queue option | |
|---|---|
| `room` | Realtime room type created per match (must be in `rooms({ rooms })`). |
| `teamSize`, `teams` | Players per team, and teams per match (default 2). Teams are balanced by snake draft on rating. |
| `rating` | `"elo"` (K = `k`, default 32) or `"glicko2-lite"` (Glicko-2 with fixed volatility). |
| `widenAfterMs` | The rating window (`initialWindow` ±100) grows by `widenBy` (100) every this many ms of waiting, up to `maxWindow`. |
| `maxWaitMs` | Stop waiting; the status becomes `timeout`. |
| `region` | Allowed regions. Players must pick one, and only meet their own region. |

The oldest waiting player anchors each match and takes the closest ratings inside its window.
Matching is a pure function of the queue and `now` (`QueueCore`), so a fake clock makes it
fully deterministic. Locally, a clock timer re-runs matching at the next widening, timeout or
expiry.

| Route (auth required) | |
|---|---|
| `POST /match/:queue/join` `{ region? }` | `{ queue, status }`. Your rating comes from the `player_ratings` table, not from the request. |
| `DELETE /match/:queue/leave` | `{ queue, left }` |
| `GET /match/:queue/status?wait=ms` | Long-poll (up to `longPollMs`, 25 s) until the status changes from `queued`/`matching`. |
| `GET /match/:queue/notify` | WebSocket per user and queue. Pushes `{"t":"match","queue","status"}` on every change. |

The status is one of: `idle`, `queued { since, window }`, `matching`, `timeout`, `failed`, or
`matched { matchId, room: { type, id, url }, ticket, team }`. Every status read mints a fresh
ticket, valid for 60 s by default.

## Tickets and game rooms: `gameRoom(type, def, opts?)`

`gameRoom` is `defineRoom` with a ticket check.

1. **Admission (authoritative)** runs in realtime's `onJoinRequest`, before the player is seated.
   - A new join must carry the ticket as `?ticket=` or as `params.ticket` in a join frame.
     `connectMatch` and the engine clients send it.
   - The ticket must be signed and unexpired, and must name this room (a shard `id:shardN` counts
     as its base id), this match and a rostered user.
   - Each user gets one live seat.
   - Otherwise the join is refused with close 4003 and takes no seat.
   - A pure resume (`?resume=<token>`) keeps the seat and needs no ticket.
   - On success, `onSeat` runs and the player gets a `seated` event.
   - Spectators may join without a ticket when you opt in with `{ spectators: true }`.
2. **HTTP gate (defense in depth, kept).** The matchmaker and lobbies plugins also check
   `?ticket=` on `GET /rooms/<game type>/<id>`, before the WebSocket upgrade. They pass a pure
   `?resume=`, and `resume + ticket` even when the ticket has expired. Anything else gets
   `401`, before it can wake a Durable Object or open a socket.
3. The `ticket` client message still exists for clients that join without params. Once a player
   is seated it is a silent no-op. Game messages from unseated players (spectators) are refused
   with `MIU_E_GAME_TICKET_REQUIRED`, except the types listed in `opts.open`.

Seats and the roster live in the room's secret state, so they survive Durable Object
hibernation. Handlers see their own `room.secret` as usual. `seatOf(room, playerId)`,
`seats(room)` and `matchOf(room)` read the game data.

`reportResult(room, { winners } | { ranking })` takes player ids or user ids, but only of seated
or rostered players. It reports once per room and returns the store's summary
(`ratings[userId].before/after`, `unlocked`).

The matchmaker or lobbies plugin receives the report together with `room.env`. On Workers that is the rooms Durable Object's env, so a `d1("DB")` database is reached directly. `gameRoom(type, def, { report: resultReporter(url) })` (a signed HTTP call) remains an option. Leaderboard submits from a room take the env the same way: `board.submit(userId, 1, { env: room.env })`.

Clients: `findMatch()` and `connectMatch()` from `@miujs/game/client` do all of this. See also
`clients/unity` and `clients/godot`.

## Lobbies: `lobbies({ rooms, room, minPlayers, maxPlayers, teams })`

`POST /lobbies` creates a lobby and returns a 6-digit `lobby.code`. Codes come from realtime's
code store: memory locally, KV via `codes` on Workers. Then:

- `POST /lobbies/join { code }` joins the lobby.
- `POST /lobbies/:id/ready { ready }` marks you ready.
- `POST /lobbies/:id/start` starts the match. Only the host can call it, once everyone else is
  ready. It creates the room and records an unrated match.
- `GET /lobbies/:id` shows the lobby to members, with their ticket once the match has started.

When the host leaves, the next member becomes host. Lobby results update stats and achievements,
not ratings.

## Profiles and ratings: `GameStore`, `profiles()`

The migrations in `gameMigrations` create these tables:

- `players`: id = auth user id, `display_name`, `avatar_key`, `games_played`, `games_won`
- `player_ratings`: per queue: rating, rd, vol, games, wins
- `game_matches`
- `player_stats`
- `player_achievements`
- `leaderboard_scores`

All of them use SQLite locally and D1 on Workers (`database` option; default `d1("DB")` on
Workers, one shared in-memory SQLite elsewhere).

`store.reportResult(matchId, result)` checks the result against the recorded roster. It then
applies ratings, games, wins/losses/draws and achievements in one transaction. Every statement is
guarded by "match still pending", so a repeated or concurrent report applies exactly once
(`duplicate: true`).

`profiles()` adds these routes:

- `GET /players/me` (auth)
- `PATCH /players/me { displayName, avatarKey }` (auth). `avatarKey` is a file key, for example
  from `@miujs/files`. It is validated and cannot contain `..`.
- `GET /players/:id`, which is also the MCP tool `player_profile`

## Leaderboards: `leaderboard({ id, sort, resets, mode, timezone, maxScore, ... })`

- `resets: "daily" | "weekly" | "monthly" | "never"`. The period keys are `2026-10-15`,
  `2026-W42` (ISO week), `2026-10` and `all`, computed in `timezone` (IANA, default `UTC`).
  Older periods stay queryable with `{ period }`.
- `mode: "best"` keeps each player's best score per period; `"sum"` adds scores up.
- Server-side calls: `submit(playerId, score)`, `top(n)`, `around(playerId, n)`, `rank(playerId)`.
  Ties share a rank (1, 1, 3).
- The board is also a plugin:
  - `GET /leaderboards/<id>/top?n=`, `/around/:playerId?n=` and `/rank/:playerId` are MCP tools
    (`leaderboard_<id>_top` and so on), so agents can read standings.
  - `POST /leaderboards/<id>/scores` is for client submissions, which are off by default.

## Achievements: `defineAchievements({ id: { title, check(stats) } })`

`stats` holds `games`, `wins`, `losses`, `draws`, plus any counters you add with
`store.addStats(playerId, { kills: 3 })`. Checks run after every stat change. Each unlock is
stored once (`INSERT OR IGNORE`) and emitted once:
`achievements.on("achievement.unlocked", ({ playerId, id, title, at }) => ...)`. Reports and
`addStats` also return the new unlocks, so rooms can forward them to players.

## Game-loop helpers

- **`fixedStep.define(name, { hz, update, maxCatchUp })`**: spread `loop.timers` into
  `defineRoom({ timers })`, then call `loop.start(room)`. Each step re-arms itself with
  `room.schedule(name, …)`. The tick counter travels in the timer data, and a late alarm catches up
  at most `maxCatchUp` steps before skipping ahead on the same cadence. `update` gets a fixed `dt`
  and the step's scheduled `now`. Return `false` to stop.
  **Durable Objects:** tick loops must use this `room.schedule` re-arming form. `room.tick` /
  `room.after` closures, and `fixedStep(room, hz, update)`, are lost when the object hibernates,
  and throw `MIU_E_GAME_LOOP_NOT_DURABLE` there.
  **Cheaper ticks:** `stepsPerAlarm: N` wakes the room once every N steps and runs the N due steps
  back to back, each with its own fixed `dt` and scheduled `now`. That is N times fewer alarms, at
  the cost of up to N-1 steps of extra latency.
- **Inputs (server):** `acceptInput(state, playerId, seq, input)` buffers inputs, drops stale and
  duplicate seqs, and caps the buffer. `processInputs(state, apply)` applies them in seq order,
  and `ackedSeqs(state)` returns `{ playerId: lastSeq }`. Put the acks in room state. The input
  state is plain JSON, so keep it in `room.secret`.
- **Client:** `predictor({ initial, apply })` provides `input()` and
  `reconcile(serverState, ackSeq)`, which replays unacked inputs. `snapshotInterpolation({ delayMs })`
  provides `push(time, state)` and `sample(now)`. `lerpState` interpolates numbers deeply, and
  angles take the short way round. Import these from `@miujs/game/client` (no server code).

## Engine clients

`clients/unity/MiuRealtime.cs` (C#) and `clients/godot/miu_realtime.gd` (GDScript) implement the
JSON wire protocol, the ticket flow and resume. `clients/protocol-vectors.json` holds the shared
conformance vectors, which `test/protocol-vectors.test.ts` checks against a JS reference.

## Trust boundaries

| Input | Trusted? | Enforcement |
|---|---|---|
| Queue join | User from auth | Rating, name and roster come from the server. The client only picks queue and region. |
| Room seat | Signed ticket (HMAC-SHA256, 60 s, bound to room type + id + match + user) | Checked at the HTTP upgrade and again in the room. One live seat per user. |
| Game moves | Seated players only | Your room handlers validate them. The room is the authority. |
| Match result | Room only | `reportResult` runs server-side, or comes through `POST /match/_result` signed with the game secret (`signResult` / `resultReporter`), with ±60 s skew. The roster is checked, and the result applies once. |
| Leaderboard scores | Room/server: trusted | `maxScore` / `minScore` still apply. |
| Leaderboard scores | Clients: off by default | With `clientSubmit: { secret }`: a server-signed proof bound to board + player + score, single-use nonce, per-player rate limit. |
| Profile edits | Owner only | Validated name and avatar key. |

`MIU_GAME_SECRET` (32+ characters) signs tickets and results. Off Workers, a random per-process
dev secret is used when it is unset, which only works single-process. On Workers it is required.

## Cloudflare

Export the Durable Objects and let `miu deploy cloudflare` read `cloudflare()`:

```ts
export const MiuRooms = createRoomDurableObject([arena]);   // MIU_ROOMS (realtime)
export const MiuMatchmaker = createMatchmakerDurableObject(mm); // MIU_MATCH: one object per queue, "match:<queue>"
export const MiuLobbies = createLobbyDurableObject(lobby);    // MIU_LOBBY: one object per lobby
```

The queue object persists after every change and runs widening, timeouts and expiry from alarms.
Notify sockets use the hibernation API, tagged by user. Long-poll `wait` is not supported there:
status answers at once, and `findMatch` falls back to polling.

Rooms get the Durable Object's `env` as `room.env`, so `reportResult(room)` and
`board.submit(..., { env: room.env })` reach D1 from inside the room. Match rooms are created
without a join code (`createRoom(type, { code: false })`). To kick a player, use realtime's
`room.kick(playerId)` (close 4009, no resume).

## Errors

| Code | When |
|---|---|
| `MIU_E_GAME_SECRET_MISSING` / `_WEAK` | No `MIU_GAME_SECRET` on Workers / shorter than 16 characters. |
| `MIU_E_GAME_TICKET_REQUIRED` | No ticket on the room upgrade, or a game message before presenting one. |
| `MIU_E_GAME_TICKET_INVALID` / `_EXPIRED` / `_USED` | Bad signature, other room, match or user; past `exp`; user already seated as another live player. |
| `MIU_E_GAME_QUEUE_UNKNOWN` / `_CONFIG` | Unknown queue; bad queue options (fails at startup). |
| `MIU_E_GAME_ALREADY_QUEUED` | Joining a queue twice. |
| `MIU_E_GAME_REGION_INVALID` | Regional queue without a valid region. |
| `MIU_E_GAME_LOBBY_NOT_FOUND` / `_FULL` / `_NOT_MEMBER` / `_NOT_HOST` / `_NOT_READY` / `_STARTED` | Lobby flow. |
| `MIU_E_GAME_MATCH_UNKNOWN` | Reporting a match that was never recorded. |
| `MIU_E_GAME_RESULT_INVALID` / `_UNSIGNED` | Result names non-players or is malformed; unsigned or stale `/match/_result`. |
| `MIU_E_GAME_SCORE_INVALID` / `_RATE_LIMITED` | Non-finite or out-of-bounds score; too many client submissions. |
| `MIU_E_GAME_CLIENT_SCORES_DISABLED` / `MIU_E_GAME_PROOF_INVALID` | Client score route off; missing, wrong or replayed proof. |
| `MIU_E_GAME_LEADERBOARD_CONFIG` / `MIU_E_GAME_TIMEZONE_INVALID` | Bad board options / time zone. |
| `MIU_E_GAME_PLAYER_NOT_FOUND` | Updating a profile that doesn't exist. |
| `MIU_E_GAME_ROOM_CONFIG` / `MIU_E_GAME_ACHIEVEMENT_INVALID` | Reserved `ticket` message, bad lobby/loop options; bad achievement definition. |
| `MIU_E_GAME_LOOP_NOT_DURABLE` | Closure loop on a Durable Object room. |
| `MIU_E_GAME_STORE_MISSING` | `reportResult` in a room no matchmaker or lobby serves (pass `report`). |

Every error carries a `fix`.
