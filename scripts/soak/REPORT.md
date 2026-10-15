# Soak report: memory, stability and speed over real HTTP and WebSockets

Date: 2026-10-15. Machine: Windows 11 laptop, 20 logical cores. Runtimes: Bun 1.4.3, Node 24.22.0 and Deno 2.x. The load generator and the server ran on the same machine over 127.0.0.1.

Code under test: branch `feat/mvp-core`.

- The final Bun runs were at `7df5ae6`, plus uncommitted work by other agents in `packages/` (13–14 files).
- The Node run was at `d53f0f2` and the Deno run at `99ea235`.
- Other agents committed fixes during and after this work. Every number below was measured before the fixes listed under "Status of findings".
- Each JSON result records the exact `HEAD` and the number of dirty files (`codeState`).

## Status of findings

| Finding | Package | Status |
| --- | --- | --- |
| F1: argon2id RSS spike on concurrent sign-ins | `@miujs/auth` | **Fixed** in the auth commit after `fa56f78`: argon2id at 19 MiB, at most 4 hashes at once. 32 concurrent verifies now peak at +78 MB RSS, down from +1,284 MB. |
| F2: `ranFor` grows forever | `examples/api` | **Fixed** in `examples/api` (coordinator, after this run). Not re-soaked. |
| F3: rate-limit windows, ~1.4 KB per new IP/account | `@miujs/auth` | Informational. Bounded by window expiry and `maxKeys`. |
| F4: finished games kept in memory for 60 s | `@miujs/game` / `@miujs/realtime` | **Fixed**: rooms close 5 s after the result (`closeAfterResultMs`). Not re-soaked. |
| F5: JSON body read ~0.4 µs slower per request | `miujs` core | **Fixed** in `fa56f78` (Content-Length requests) and the follow-up body-read commit (requests without one): `POST /json` is at 103–104% of the best other framework, peak heap 9 KB per 10k requests (was 265 KB). |
| Long-poll ignores client disconnect | `@miujs/game` | **Fixed**: the wait ends when the request is aborted (`ctx.req.signal`). |
| Shutdown hang with open room timers | `miujs` / `@miujs/realtime` | **Fixed** in `3d837b1` (`app.stop()` and the plugin `stop()` hook). |
| Expired join codes, sessions and limiter windows not swept | `@miujs/realtime`, `@miujs/session`, `@miujs/auth` | **Fixed** by other agents during this work. |

## How it works

### The server wrappers

- **`scripts/soak/serve-bun.ts`** loads an example **unchanged**: its `createApp()` or default export, with production defaults (real argon2id cost, in-memory SQLite). It serves the app the way `app.listen()` does on Bun (`Bun.serve` + `app.fetch` + `app.websocket`) and adds debug-only routes the app never sees:
  - `GET /__soak/mem[?gc=1][&types=1]` returns RSS, JSC heap, object counts, in-flight requests and live rooms.
  - `GET /__soak/stop` runs `server.stop()`, then `app.stop()`, then nothing. The process should then exit on its own.
  - One test-only shim: an `x-soak-ip` header sets the client IP the app sees. Without it, per-IP sign-in limits would block the load.
- **`scripts/soak/serve-core.ts`** serves the bare core app with `app.listen()` on Bun, Node or Deno. The app (`core-app.ts`) has `GET /json`, `GET /users/:id` with integer params, and `POST /echo` with body validation.

### The runner: `scripts/soak/run.ts`

For each app it does four steps:

1. **Cold start.** Spawn the server and time it to the first response from a real app route. Then read idle RSS after 2 s and a GC, stop the server, and time the exit.
2. **Soak.** Start a fresh server and run *N* virtual clients for the duration (60 s, or 15 s with `--quick`). `/__soak/mem` is sampled every second. Three samples are taken after a GC, with object-type counts:
   - *warm-up*: at 20% of the duration (12 s into a 60 s run);
   - *end*: right after the load stops;
   - *settled*: after 5 s idle, or 65 s for realtime apps (30 s reconnect grace + 30 s empty-room disposal).
3. **Stuck-handler checks:**
   - 200 raw sockets that send the headers and half a body, then drop.
   - 200 `fetch()` calls aborted 0–3 ms in.
   - Realtime apps only: 50 hand-made WebSocket handshakes that drop the TCP socket after `welcome`, with no close frame.
   - Arena only: one client that queues, starts a 20 s long-poll and vanishes.

   After these, the runner checks that in-flight requests are back to 0, that the server still answers, and how many room connections remain.
4. **Graceful shutdown on the loaded server.** After `/__soak/stop`, the process must exit within 3 s. If it does not, the runner waits up to 90 s more and reports when it eventually exits.

Two helpers support the runner:

- `scripts/soak/driver.ts` runs virtual clients in child processes. The high-RPS core app uses 3 of them.
- `scripts/soak/repro/*.ts` holds focused reproductions (see Findings).

**Leak flag:** the heap after GC grows more than 10% from the warm-up sample, at *end* or at *settled*. Realtime apps keep rooms for 60 s on purpose, so for them the *settled* sample decides.

### Load per app

**core** (64 clients, from 3 driver processes): 80% `GET /json`, 15% `GET /users/:id`, 5% `POST /echo`, as fast as possible.

**api** (notes, 32 clients). Each client loops:

1. Registers from a new IP, logs out, then logs in from another new IP.
2. Runs 400 operations:
   - list notes, mostly cache hits: 45%
   - create a note: 20%
   - get a note: 15%
   - delete a note: 10%
   - `/auth/me`: 10%
3. Keeps at most 10 notes, then deletes them all and logs out. A new user starts.

Every note created dispatches a queue job.

**quiz** (40 concurrent games). Each game:

1. `POST /api/games`; sometimes also resolves the join code.
2. A host and 3–7 players join over WebSocket. Half the games get a late joiner in round 1.
3. All players answer 5 questions and the host advances each round.
4. In a third of the games, a player leaves after round 3, so round 4 closes on the 20 s deadline timer.
5. Everyone disconnects and a new game starts.

**crm** (24 clients). Each client:

1. Logs in through the admin form as owner, admin or sales (the accounts from the example's `seed.ts`).
2. Runs 500 operations:
   - API lists with filter, search and sort
   - creates, updates and deletes contacts (each new lead triggers the follow-up workflow)
   - admin UI pages: list, pipeline kanban, record, dashboard

**arena** (80 players). Each player loops:

1. `findMatch`: join, then long-poll the status.
2. Connects with the ticket.
3. Plays tic-tac-toe with random legal moves until the game is over.
4. Leaves and repeats.

## Results (Bun, 60 s each)

**Throughput and latency**

| App | ops/s | p50 ms | p95 ms | p99 ms | Errors |
| --- | ---: | ---: | ---: | ---: | ---: |
| core | 69,527 | 0.91 | 1.21 | 1.61 | 0 |
| api | 10,412 | 1.72 | 4.61 | 8.53 | 0 |
| quiz | 236 (plus 1,465 WS frames/s in) | 5.97 | 7.43 | 18.0 | 0 |
| crm | 1,329 | 13.6 | 34.8 | 52.7 | 1,574 ¹ |
| arena | 9,672 (plus 10,617 WS frames/s in) | 6.20 | 66.0 | 106 | 0 |

**Memory**

| App | RSS start / peak / end MB | Heap after GC: warm-up → end → settled MB | Growth end / settled | Verdict |
| --- | --- | --- | --- | --- |
| core | 39.1 / 53.7 / 46.9 | 0.8 → 0.7 → 0.6 | −10% / −17% | flat |
| api | 43.1 / **1,353** / 67.1 | 3.7 → 6.5 → 6.2 | +77% / +68% | grows: the example's `ranFor` plus auth limiter windows (F2, F3) |
| quiz | 42.9 / 65.6 / 64.9 | 3.7 → 4.7 → 1.2 | +28% / **−67%** | no leak: rooms are kept 60 s by design, then all disposed |
| crm | 60.2 / **461** / 153.7 | 10.5 → 10.2 → 9.3 | −3% / −11% | flat |
| arena | 49.1 / 444 / 393 | 49.1 → **131.8** → 2.8 | +168% / **−94%** | no leak, but finished games are held heavily (F4) |

¹ Every crm error is a `429` on `POST /admin/login`. The harness logs in again every 500 operations, so the three seeded accounts hit the per-account sign-in limit (50 per 15 min). That is the auth rate limiter working as designed. No other request failed.

"ops" counts HTTP requests plus timed WebSocket round trips.

### Per-operation latency (p50 / p99 ms)

**api**

- Notes routes: ~1.7 / 7.2, at 1.4k–4.2k requests/s each.
- `register`: 195 / 541. `login`: 190 / 426. Both are dominated by argon2id cost (before the F1 fix).

**quiz**

- A WebSocket answer until it is acknowledged in state: 6.1 / 7.8.
- The host's start or next until every player sees the question: 6.1 / 11.4.
- Joins: 2.0 / 25.

**arena** (~1,160 games/s)

- Matchmaking, from join to matched: 10.1 / 81.5.
- Ticket to seated: 9.2 / 29.
- A move until the board updates: 5.4 / 13.7.
- A whole game: 62 / 185.

**crm**

- API reads: ~12 / 33.
- Admin pages: ~12–13 / 34.
- Writes (create, update, delete, with audit and workflows): ~18–23 / 64.
- Login: 115 / 393.

### Idle and startup (Bun)

| App | Process ready (ms) | First response (ms) | Idle RSS after start (MB) | Idle heap (MB) | Idle RSS after load + settle (MB) | Heap after load + settle (MB) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| core (Bun.serve wrapper) | 61 | 67 | 38.2 | 0.5 | 42.8 | 0.6 |
| core (`app.listen`) | 41 | 46 | 26.0 | 0.4 | 36.7 | 0.6 |
| api | 33 | 40 | 44.6 | 1.1 | 62.4 | 6.2 |
| quiz | 28 | 31 | 42.3 | 0.7 | 57.3 (65 s settle) | 1.2 |
| crm (without seeding) | 63 | 76 | 55.2 | 4.1 | 149.7 | 9.3 |
| arena | 37 | 45 | 50.4 | 1.2 | 128.0 (65 s settle) | 2.8 |

- "Process ready" is measured from spawn, as seen by the runner, so it includes Bun's own start (~20–40 ms).
- The crm cold start skips the example's seed (`SOAK_NO_SEED=1`). Seeding hashes 3 passwords and adds ~250 ms.

After load, RSS stays well above where it started, even when the JS heap is back to idle size:

- arena: 128 MB RSS with a 2.8 MB heap
- crm: 150 MB RSS with a 9 MB heap

That is the allocator and GC keeping pages after the peaks (argon2 buffers, tens of thousands of rooms), not a JS leak. In every app the settled heap is at or below the warm-up heap.

### Runtimes: the bare core app via `app.listen()`

Each runtime ran 60 s with 64 clients from 3 Bun driver processes.

**Throughput and latency**

| Runtime | ops/s | p50 ms | p95 ms | p99 ms | Errors |
| --- | ---: | ---: | ---: | ---: | ---: |
| Bun 1.4.3 | **69,612** | 0.90 | 1.24 | 1.73 | 0 |
| Deno 2 | 66,133 | 0.86 | 1.86 | 2.61 | 0 |
| Node 24 | 26,489 | 2.29 | 3.51 | 5.92 | 0 |

**Startup, memory and shutdown**

| Runtime | First response (ms) | Idle RSS (MB) | RSS peak / end (MB) | Heap warm-up → settled (MB) | Shutdown |
| --- | ---: | ---: | --- | --- | --- |
| Bun 1.4.3 | **46** | **26.0** | 46.2 / 39.5 | 0.7 → 0.6 | exits in 16 ms |
| Deno 2 | 78 | 37.6 | 48.2 / 46.9 | 3.7 → 3.6 | exits in 42 ms |
| Node 24 | 203 | 71.2 | **191.7 / 190.1** | 9.0 → 8.8 | exits in 33 ms |

- **No leaks on any runtime.** The heap is flat on all three, the mid-body and aborted-fetch checks pass, and the server answers afterwards.
- **Bun vs Deno.** Throughput is close, but Deno's tail latency is about 50% longer.
- **Node throughput.** The Node adapter (`packages/miujs/src/node.ts`, which converts `node:http` to `Request`/`Response`) reaches about 38% of Bun's throughput.
- **Node memory.** RSS climbs to about 190 MB under load and stays there, while the V8 heap is about 9 MB. The extra memory is native (`node:http` and stream buffers), not JS objects.
- **Node cold start** is the slowest at 203 ms, because it strips types from many `.ts` source files on every start.
- **Load-generator caveat.** The clients are Bun processes on the same machine, using about 3 cores. Bun and Deno may be close to the client's limit, so treat 66–70k ops/s as a lower bound for both.

## Stuck processes and shutdown

### Graceful shutdown

The test: call `server.stop()` and then `app.stop()`; the process must exit within 3 s.

| App | Idle server | After 60 s of load | `exitCheck` repro (`repro/shutdown.ts`) |
| --- | --- | --- | --- |
| core | 13 ms | 15 ms | 31 ms |
| api | 16 ms | 16 ms | 51 ms |
| quiz | 15 ms | 13 ms | 36–168 ms (3 cases) |
| crm | 11 ms | 18 ms | 117 ms |
| arena | 11 ms | 23 ms | 62–163 ms |
| core on Node / Deno | 21 / 48 ms | 33 / 42 ms | – |

All apps pass.

**Fixed: quiz did not exit before `3d837b1`.**

- If a game was in its question phase, a stopped server stayed alive until that room's 20 s `reveal` timer fired.
- In `repro/shutdown.ts`, the case "quiz: question open" exited after 20,043 ms before the fix, and after 125 ms with it.
- Room timers deliberately keep the process alive ("named timers are game logic"), and nothing closed rooms on shutdown until `app.stop()` and plugin `stop()` hooks existed.
- Keep `repro/shutdown.ts` as the regression check.

### Client disconnects mid-request or mid-WebSocket

| App | In flight 2 s after 200 half-sent bodies + 200 aborted fetches | Server answers afterwards | Still connected 2 s after 50 WebSockets dropped with no close frame |
| --- | ---: | --- | ---: |
| core | 0 | yes | – |
| api (`POST /auth/login`) | 0 | yes | – |
| quiz (`POST /mcp`) | 0 | yes | **0** (the 50 rooms and seats are kept for the reconnect grace, as designed) |
| crm (`POST /api/contacts`) | 0 | yes | – |
| arena (`POST /match/duel/join`) | 0 | yes | – (rooms are ticket-gated) |
| core on Node / Deno | n/a ² | yes | – |

² `serve-core.ts` has no in-flight counter. A hung body read would show up as the server not answering, or the process not exiting on stop. Neither happened.

**The arena long-poll ignores client disconnects** (minor; FIXED: the wait now ends on `ctx.req.signal` abort).

- What happens: a client queues, starts `GET /match/duel/status?wait=20000`, and vanishes after 100 ms. The handler keeps waiting.
- Evidence: one request is **still in flight 2 s after the abort**, and none only after the 20 s wait expires. See `stuck.inflight2sAfterAbort` and `inflight21sAfterAbort` in `results/bun-arena.json`.
- Impact: the wait is bounded, but a client can hold one timer and one subscription per request for the whole long-poll without keeping a socket open.
- Fix: in `packages/game/src/matchmaker.ts` (`match_status`), also resolve when `ctx.req.signal` aborts, and unsubscribe.

## Findings

### F1. `@miujs/auth`: concurrent sign-ins spike RSS by 64 MiB each (high; FIXED)

**Cause.** Passwords were hashed with argon2id through `Bun.password` at Bun's defaults (`m=65536,t=2,p=1`, i.e. 64 MiB per hash), with no limit on how many run at once.

**Evidence** (before the fix):

| Concurrent `verifyPassword` | Peak RSS above baseline | Back to baseline after |
| ---: | ---: | --- |
| 1 | +64 MB | yes |
| 8 | +512 MB | yes |
| 32 | +1,282 MB (Bun's thread pool caps it at ~20 concurrent) | yes |

Reproduce with `bun scripts/soak/repro/argon2-burst.ts 32`.

**In the soak:**

- api peaked at **1.35 GB RSS** with 32 clients signing in, while its JS heap stayed under 7 MB.
- crm peaked at 461 MB RSS, with its JS heap under 11 MB.
- Failed logins cost the same: the dummy hash used for unknown emails is just as expensive.

**Fix** (the auth commit after `fa56f78`): argon2id at 19 MiB, at most 4 hashes at once. 32 concurrent verifies now peak at +78 MB RSS. The api and crm peaks above were measured before the fix.

### F2. `examples/api` (example code, not a package): `ranFor` grows forever (FIXED)

- **Cause.** The example's `note-created` job pushed every note title onto `ranFor`, an array kept as a hook for its tests.
- **Evidence.**
  - After 60 s the array held 112,557 strings. The settled heap went from 3.7 to 6.2 MB, with 92,729 more `string` objects.
  - With `SOAK_TRIM_RANFOR=1`, the wrapper empties the array every second. The string growth then disappears and settled growth falls from +68% to +11% (`results/bun-api-trimmed-ranFor.json`).
- **Fix.** The coordinator changed `examples/api` after this run. It has not been re-soaked.

### F3. `@miujs/auth`: in-memory rate-limit windows, ~1.4 KB per new IP/account (bounded, informational)

- **What.** The remaining +11% in api is about 4 `Object`s per signed-up user. They are the default `memoryRateLimiter` windows for the keys `register:ip`, `login:ip-account`, `login:account` and `login:ip`.
- **Evidence.** `bun scripts/soak/repro/auth-retention.ts 1000` measures:

  | Rate limiter | Heap per user | Objects per user |
  | --- | ---: | ---: |
  | on (default) | +1,442 B | +4.17 |
  | `rateLimit: false` | +268 B | +0.17 |

- **Why it is not a leak.** Windows expire after 15–60 min, and the limiter now sweeps expired entries and caps the map at `maxKeys` (50k entries), about 70 MB worst case at the cap.
- **Why it matters.** Count it when sizing memory for public sign-up endpoints.

### F4. `@miujs/game` + `@miujs/realtime`: finished games stay in memory for 60 s (medium; FIXED: `gameRoom(..., { closeAfterResultMs })`, default 5000, closes the room after `game.closed`)

**What.** When an arena game is `over` and both players have left, the room is still kept: first for the 30 s reconnect grace, then for the 30 s `emptyMs`.

**Evidence.**

- At ~1,160 games/s the registry held up to **34,882 rooms**.
- The heap after GC reached **131.8 MB**, about 3.5 KB per finished room.
- Per-second samples (heap not after GC):

  | Time | Heap | Live rooms |
  | --- | ---: | ---: |
  | 10 s | 54 MB | 6,325 |
  | 31 s | 141 MB | 19,118 |
  | 53 s | 185 MB | 31,322 |
  | 64 s (load stops) | 187 MB | 32,029 |
  | 121 s | 138 MB | 4 |
  | 143 s | 143 MB | 0 |

- After GC, the settled heap was 2.8 MB. RSS stayed at 128 MB after the heap emptied.

**Why it matters.** Everything is released, so this is not a leak. But steady-state memory is `game rate × 60 s × 3.5 KB`, with no cap.

**Suggestions:**

- Let a game room close itself, or shorten its grace period, once it reports a result: `reportResult()` or phase `over` in `packages/game/src/room.ts`.
- Or give matchmaker-created rooms a much shorter `emptyMs` in `packages/realtime/src/registry.ts`.

The quiz example shows the same pattern at a smaller scale: up to 360 live rooms for 40 concurrent games, all disposed after settle.

### F5. `miujs` core: JSON body reading cost ~0.4 µs more per request (perf regression; FIXED in `fa56f78`)

**Cause.** Since `5aae15e`, `readBody` → `readLimited` read JSON bodies with `new Uint8Array(await req.arrayBuffer())` plus `TextDecoder`.

**Evidence.** A/B microbenchmark on Bun 1.4.3, per request, including `new Request`:

| Body read | ns per request |
| --- | ---: |
| `arrayBuffer` + decode + parse | ~1,450 |
| `req.text()` + parse | ~1,100 |
| `req.json()` | ~960 |

- In `bench/run.ts`, `POST /json` fell from 106–111% to 84–92% of the best other framework.
- It was also the only MiuJS route with a large transient heap: 288 KB per 10k requests, against 4–14 KB for Elysia and Hono.

**Fix.** `fa56f78` brings `POST /json` back to ~378k req/s in-process. The regression note and the 84–92% row in `bench/README.md` predate the fix; re-run `bun bench/run.ts` to refresh them.

### F6. Fixed by other agents during this work (verified)

- **Shutdown hang with open game timers:** fixed in `3d837b1` (see "Graceful shutdown").
- **`@miujs/realtime` `MemoryCodeStore`:** expired join codes were deleted only when someone looked them up again, so every `createRoom` kept a 6-hour code forever. The store now sweeps expired codes.
- **`@miujs/session` `memorySessionStore` and `@miujs/auth` `memoryRateLimiter`:** expired entries are now swept. The api and crm examples use cookie sessions, so the soak did not exercise the session store.

### What the soak did not find

- No growth in core request handling on any runtime. On Bun the heap stayed flat over 4.17M requests.
- No hung handler after half-sent bodies or aborted fetches, in any app.
- No room left `connected` after abrupt WebSocket drops.
- No shutdown hang at the final code.
- crm (admin UI, audit, workflows, SQLite) settled 11% *below* its warm-up heap.

## Reproduce

Run everything from the repo root, with Bun 1.4.3. Results go to `scripts/soak/results/` as `<runtime>[-listen]-<app>.json`. Each file holds per-second samples, object-type diffs and per-operation latency.

```bash
# Full soak, every example on Bun (60 s each; realtime apps settle 65 s) – about 12 minutes
bun scripts/soak/run.ts
bun scripts/soak/run.ts --quick                       # 15 s each, 5 s settle
bun scripts/soak/run.ts --apps=arena --duration=120   # one app, longer

# Bare core app on each runtime via app.listen()
bun scripts/soak/run.ts --apps=core --listen
bun scripts/soak/run.ts --apps=core --runtime=node    # set NODE_BIN=... to override the path
bun scripts/soak/run.ts --apps=core --runtime=deno    # set DENO_BIN=... to override the path

# F2 attribution: the same api soak with the example's ranFor array emptied every second
SOAK_TRIM_RANFOR=1 bun scripts/soak/run.ts --apps=api --skip-cold --skip-checks

# Focused reproductions
bun scripts/soak/repro/argon2-burst.ts 32            # F1
bun scripts/soak/repro/auth-retention.ts 1000        # F3
bun scripts/soak/repro/shutdown.ts                   # graceful exit per example (exitCheck)
EXIT_LIMIT_MS=40000 bun scripts/soak/repro/shutdown.ts "quiz: question"   # time to eventual exit

# Benchmark (req/s, heap per 10k requests, cold start) – see bench/README.md
bun bench/run.ts
```

Other `run.ts` options:

- `--settle=<s>`: how long to stay idle before the settled sample.
- `--exit-wait=<s>`: how long to keep waiting for an exit after the 3 s shutdown limit passes.
- `--drivers=<n>`: number of load-driver processes.
- `--skip-checks`: skip the stuck-handler checks.
- `--skip-cold`: skip the cold-start step.

## Noise and caveats

- **Shared machine.** The load generator and the server shared a 20-thread laptop that throttles under sustained load, and other agents ran `bun test` suites during some runs. Treat absolute ops/s as ±10–15%, and compare apps or runtimes only within one table.
- **Moving code.** Package sources changed while the soak ran (see `codeState` in each result file). The tables come from the last run of each app, and the fixes for F1, F2 and F5 landed after it.
- **Heap metrics differ by engine.** "Heap" is JSC `heapStats().heapSize` after `Bun.gc(true)` on Bun, and V8 `heapUsed` after `gc()` on Node and Deno. The engines count differently, so compare heap *trends* across runtimes, not absolute sizes.
- **Per-second samples** in the JSON are taken without a GC first, so they include garbage as well as live data.
