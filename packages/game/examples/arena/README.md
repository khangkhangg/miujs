# Arena: ranked tic-tac-toe on @miujs/game

This is a two-player game that uses every part of the kit:

- the **matchmaker** (`duel` queue, Elo, widening window)
- a **ticket-gated room** (`room.ts`), where the room is the authority on turns and wins
- **ratings**, reported once by the room
- a weekly **leaderboard** (`arena-wins`, sum of wins)
- an **achievement** (`firstWin`)
- **profiles** (`GET /players/me`)

```bash
bun packages/game/examples/arena/app.ts
```

The app signs players in with a demo auth plugin: `Authorization: Bearer guest:<name>` makes you
`g_<name>`. It is for demos only; use `@miujs/auth` in a real game.

## Flow

1. `POST /match/duel/join`, then `GET /match/duel/status?wait=20000` until `state: "matched"`.
   The matched status has `room.url` and a `ticket`.
2. Connect a WebSocket to `room.url?name=…&ticket=…`. The room admits you with the ticket before
   seating you, then sends the `seated` event. `connectMatch()` from `@miujs/game/client` does this.
3. Team 0 plays X and moves first: `{"t":"msg","type":"move","data":{"cell":0}}`.
4. On a win or draw, the room calls `reportResult()` (Elo ±16 for an even duel) and adds one
   point to `arena-wins`. It broadcasts `game.over` with the rating changes, and sends
   `achievement.unlocked` to whoever unlocked something.

## Agents

With `mcp: true`, these tools are available at `POST /mcp`:

- `leaderboard_arena-wins_top`, `_around` and `_rank`
- `player_profile`
- `match_status`
- `rooms_list` and `room_state`

## Cloudflare

The Durable Objects `MiuRooms` (`MIU_ROOMS`) and `MiuMatchmaker` (`MIU_MATCH`) are exported from
`app.ts`, and the data lives in D1 (`DB`). Set `MIU_GAME_SECRET`.

The room reaches D1 through `room.env` (the Durable Object's env), both for `reportResult` and for
the leaderboard submit.

## Test

`packages/game/test/arena.test.ts` drives the whole flow over real WebSockets on Bun.
