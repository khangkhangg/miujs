# Quiz — a Kahoot-style game on MiuJS realtime rooms

One host screen, any number of phones. Server-authoritative state, live scoring, and the
correct answer never leaves the server before the reveal.

## Run

```bash
bun install                 # once, at the repo root
bun examples/quiz/app.ts    # → http://localhost:3000   (PORT=4000 to change)
```

1. Open http://localhost:3000 and click **Create game**. You are the host; a 6-digit code appears.
2. Open the same URL in other browsers or phones on your network, enter the code and a name.
3. The host presses **Start**, then **Next question** after each reveal.

Scoring: a correct answer is worth `500 + 500 × speed`, where speed is the share of the
20-second timer left when you answered. A question closes when everyone answered or time runs out.

## Test

```bash
bun test examples/quiz
```

`test/quiz.test.ts` plays a full game with a host and three fake players on a fake clock
(no network, no waiting) and checks scores, phases, permissions, and that no frame contains
a `correct` field before the reveal. `test/app.test.ts` plays over real WebSockets.

## Files

| File | What |
|------|------|
| `room.ts` | The quiz room: state schema, `start` / `answer` / `next` handlers, scoring, and the question deadline as a named timer (`timers.reveal`, scheduled with `room.schedule`) so it survives Durable Object hibernation. `quizView`: the host (and spectators) see the whole state, a player's phone only the question, the top 10 and `me` (own score, answered, rank). A join or an answer therefore reaches the host and that player, not everyone, so 1,000 players cost O(N) frames, not O(N²). `createQuiz(questions)` builds one with your own questions. |
| `app.ts` | The server: rooms plugin, `POST /api/games` (`createRoom` → room id + 6-digit code), `GET /rooms/code/:code` (code → room id, rate-limited per IP), `GET /` (the web page), MCP on. |
| `public/index.html` | Single-file vanilla JS client speaking the [wire protocol](../../packages/realtime/PROTOCOL.md). |

## For agents

With the server running, MCP is at `POST /mcp`:

- `rooms_list` → active rooms and player counts
- `room_state` `{ "type": "quiz", "id": "123456" }` → current state and players (never the answers)

## Cloudflare Workers

`app.ts` already exports the Durable Object class. Bind it as `MIU_ROOMS`:

```toml
[[durable_objects.bindings]]
name = "MIU_ROOMS"
class_name = "MiuRooms"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["MiuRooms"]

[[kv_namespaces]]
binding = "ROOM_CODES"   # join codes (rooms({ codes: "ROOM_CODES" }))
id = "<your KV namespace id>"
```

`miu deploy cloudflare` generates this from the rooms plugin. Note: `GET /` reads
`public/index.html` from disk, so on Workers serve it as a static asset instead.
