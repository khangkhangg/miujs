# Soak report: memory, stability and speed over real HTTP and WebSockets

Date: 2026-10-15. Machine: Windows 11 laptop, 20 logical cores. Runtimes: Bun 1.4.3, Node 24.22.0 and Deno 2.x. The load generator and the server ran on the same machine over 127.0.0.1.

Code under test: branch `feat/mvp-core`.

- The final Bun runs were at `7df5ae6`, plus uncommitted work by other agents in `packages/` (13–14 files).
- The Node run was at `d53f0f2` and the Deno run at `99ea235`.
- Other agents committed fixes during and after this work. Numbers marked "before" were measured before the fixes listed under "Status of findings"; numbers marked "after" come from the re-soak described below.
- Each JSON result records the exact `HEAD` and the number of dirty files (`codeState`).

**Re-soak after the fixes** (same day, same machine, same parameters: 60 s, same concurrency, 65 s settle for realtime apps):

- Code: `2891f99` (includes `4754301` F1, `e6bad9c` F2, `6ddb1ae` F4 + long-poll, `fa56f78` + `553cedc` F5), plus one uncommitted file by another agent (`packages/miujs/src/app.ts`) and the new, unused `packages/bots/`.
- Re-soaked: core (Bun wrapper, Bun `app.listen`, Node, Deno), api, quiz, arena. crm was not re-run.
- Results are saved next to the originals with an `-after` suffix (`results/*-after.json`, `full-bun-after.log`, `runtimes-after.log`, `bench-after.log`). The "before" numbers below are the original runs.
- The machine is shared with other agents. The runner now records whole-machine CPU before each app (3–10% idle load on every run) and per second during load. quiz showed noisy tail latency and was run three times (see "Noise and caveats").

## Status of findings

| Finding | Package | Status | Before → after (re-soak) |
| --- | --- | --- | --- |
| F1: argon2id RSS spike on concurrent sign-ins | `@miujs/auth` | **Fixed** in `4754301`: argon2id at 19 MiB, at most 4 hashes at once. **Verified.** | `argon2-burst.ts 32`: +1,282 MB → **+77 to +96 MB** peak RSS (8 at once: +512 → +76 MB). api soak RSS peak **1,353 → 177 MB**; `register` p50/p99 195/541 → 29/96 ms. |
| F2: `ranFor` grows forever | `examples/api` | **Fixed** in `e6bad9c` (keeps the last 100). **Verified.** | `ranFor` length after 60 s: 112,557 → **100**. api settled heap 6.2 → **3.9 MB**; settled growth +68% → **+16.5%**; growing `string`s +92,729 → +7,200. The rest is F3 (bounded), see F2 below. |
| F3: rate-limit windows, ~1.4 KB per new IP/account | `@miujs/auth` | Informational. Bounded by window expiry and `maxKeys`. | Now the only api growth: +7,626 `Object`s for ~1,925 users after warm-up, 3.96 per user (F3 measured 4.17). |
| F4: finished games kept in memory for 60 s | `@miujs/game` / `@miujs/realtime` | **Fixed** in `6ddb1ae`: rooms close 5 s after the result (`closeAfterResultMs`). **Verified.** | arena live rooms: peak 34,882 → **3,091** (flat at ~3,000 = games/s × 5 s); at end of load 22,726 → **0**. Heap after GC at end 131.8 → **3.2 MB**; RSS peak / settled 444 / 128 → **152 / 80 MB**. |
| F5: JSON body read ~0.4 µs slower per request | `miujs` core | **Fixed** in `fa56f78` + `553cedc`. **Verified.** | `bun bench/run.ts` `POST /json`: 347,000 req/s (92% of best other) → **408,500 (104%)**; peak heap per 10k requests 288 KB → **7.8 KB**. Over real HTTP the core soak is load-generator bound (unchanged, see below). |
| Long-poll ignores client disconnect | `@miujs/game` | **Fixed** in `6ddb1ae`: the wait ends when the request is aborted (`ctx.req.signal`). **Verified.** | Requests in flight 2 s after the client vanished: 1 → **0**. |
| Shutdown hang with open room timers | `miujs` / `@miujs/realtime` | **Fixed** in `3d837b1` (`app.stop()`, since renamed `app.close()`, and the plugin `stop()` hook). | Still passes: 12–46 ms after load on every re-soaked app and runtime. |
| Expired join codes, sessions and limiter windows not swept | `@miujs/realtime`, `@miujs/session`, `@miujs/auth` | **Fixed** by other agents during this work. | – |
| F7 (new, minor): `findMatch` does not leave the queue when it gives up | `@miujs/game` client | **Fixed**: `findMatch` calls `DELETE /match/:queue/leave` (best effort) before throwing `MIU_E_GAME_MATCH_TIMEOUT`. See F7. | – |

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

"Before" is the original run; "after" is the re-soak at `2891f99`. crm was not re-run.

**Throughput and latency**

| App | ops/s before → after | p50 ms | p95 ms | p99 ms | Errors |
| --- | ---: | ---: | ---: | ---: | ---: |
| core | 69,527 → 68,016 | 0.91 → 0.91 | 1.21 → 1.33 | 1.61 → 2.20 | 0 → 0 |
| api | 10,412 → **17,697** ² | 1.72 → 1.46 | 4.61 → 2.97 | 8.53 → 4.42 | 0 → 0 |
| quiz | 236 → 234 (plus ~1,465 WS frames/s in) | 5.97 → 6.08 | 7.43 → 9.53 | 18.0 → 34.4 ³ | 0 → 0 |
| crm | 1,329 (not re-run) | 13.6 | 34.8 | 52.7 | 1,574 ¹ |
| arena | 9,672 → 9,896 (plus ~10,600 WS frames/s in) | 6.20 → 6.45 | 66.0 → 66.6 | 106 → 89.5 | 0 → 0 |

**Memory**

| App | RSS start / peak / end MB | Heap after GC: warm-up → end → settled MB | Growth end / settled | Verdict |
| --- | --- | --- | --- | --- |
| core before | 39.1 / 53.7 / 46.9 | 0.8 → 0.7 → 0.6 | −10% / −17% | flat |
| core after | 28.1 / 48.7 / 39.7 | 0.8 → 0.7 → 0.6 | −10% / −17% | flat |
| api before | 43.1 / **1,353** / 67.1 | 3.7 → 6.5 → 6.2 | +77% / +68% | grows: the example's `ranFor` plus auth limiter windows (F2, F3) |
| api after | 37.7 / **177** / 63.4 | 3.3 → 4.3 → 3.9 | +29% / +16.5% | F1 and F2 fixed; what remains is F3 limiter windows (~4 `Object`s per user, bounded), with ~2× as many users as before |
| quiz before | 42.9 / 65.6 / 64.9 | 3.7 → 4.7 → 1.2 | +28% / **−67%** | no leak: rooms are kept 60 s by design, then all disposed |
| quiz after | 40.7 / 63.2 / 63.1 | 3.7 → 4.7 → 1.2 | +28% / −67% | unchanged (quiz rooms do not use `gameRoom`, so F4's fix does not apply): peak 360 rooms, 280 at end of load, 0 settled |
| crm (not re-run) | 60.2 / **461** / 153.7 | 10.5 → 10.2 → 9.3 | −3% / −11% | flat |
| arena before | 49.1 / 444 / 393 | 49.1 → **131.8** → 2.8 | +168% / **−94%** | no leak, but finished games are held heavily (F4) |
| arena after | 46.3 / **152** / 82.5 | 24.3 → **3.2** → 3.0 | −87% / −88% | flat: finished rooms close 5 s after the result; 0 live rooms at end of load |

¹ Every crm error is a `429` on `POST /admin/login`. The harness logs in again every 500 operations, so the three seeded accounts hit the per-account sign-in limit (50 per 15 min). That is the auth rate limiter working as designed. No other request failed.

² api clients spend much less time in `register`/`login` (argon2id at 19 MiB, F1), so they do ~70% more notes requests and sign up ~2,400 users instead of ~1,450 in 60 s. Compare per-route latency, not total ops/s.

³ quiz tail latency varied run to run on the shared machine (p99 32, 94 and 34 ms in three after-runs; the table shows the quietest). Its p50 and its answer/broadcast latency are unchanged; no fix touched quiz. See "Noise and caveats".

"ops" counts HTTP requests plus timed WebSocket round trips.

### Per-operation latency (p50 / p99 ms)

**api**

- Notes routes: ~1.7 / 7.2, at 1.4k–4.2k requests/s each (after: ~1.4 / 4.4, at 2.3k–7.2k requests/s each).
- `register`: 195 / 541 → **28.5 / 96**. `login`: 190 / 426 → **28.2 / 235**. Before the F1 fix both were dominated by argon2id cost at 64 MiB with no cap.

**quiz**

- A WebSocket answer until it is acknowledged in state: 6.1 / 7.8.
- The host's start or next until every player sees the question: 6.1 / 11.4.
- Joins: 2.0 / 25.

**arena** (~1,160 games/s before, ~1,190 after; before → after)

- Matchmaking, from join to matched: 10.1 / 81.5 → 10.4 / 56.4.
- Ticket to seated: 9.2 / 29.
- A move until the board updates: 5.4 / 13.7.
- A whole game: 62 / 185 → 63.7 / 124.

**crm**

- API reads: ~12 / 33.
- Admin pages: ~12–13 / 34.
- Writes (create, update, delete, with audit and workflows): ~18–23 / 64.
- Login: 115 / 393.

### Idle and startup (Bun, before)

After the fixes, first response was 34 ms (core wrapper), 42 ms (core `app.listen`), 54 ms (api), 45 ms (quiz) and 57 ms (arena), within run-to-run noise of the table. Idle RSS after load + settle fell for arena (128.0 → 80.0 MB) and api (62.4 → 56.7 MB); the others moved by about 4–6 MB.

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

That is the allocator and GC keeping pages after the peaks (argon2 buffers, tens of thousands of rooms), not a JS leak. In every app the settled heap is at or below the warm-up heap. With the F1 and F4 fixes the peaks are smaller, and so is the retained RSS: arena settles at 80 MB.

### Runtimes: the bare core app via `app.listen()`

Each runtime ran 60 s with 64 clients from 3 Bun driver processes.

**Throughput and latency**

| Runtime | ops/s before → after | p50 ms | p95 ms | p99 ms | `POST /echo` (JSON body) req/s | Errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Bun 1.4.3 | **69,612 → 69,951** | 0.90 → 0.90 | 1.24 → 1.18 | 1.73 → 1.70 | 3,473 → 3,493 | 0 |
| Deno 2 | 66,133 → 67,385 | 0.86 → 0.86 | 1.86 → 1.84 | 2.61 → 2.65 | 3,310 → 3,362 | 0 |
| Node 24 | 26,489 → 26,772 | 2.29 → 2.29 | 3.51 → 3.37 | 5.92 → 5.15 | 1,330 → 1,340 | 0 |

**Startup, memory and shutdown** (before → after)

| Runtime | First response (ms) | Idle RSS (MB) | RSS peak / end (MB) | Heap warm-up → settled (MB) | Shutdown after load |
| --- | ---: | ---: | --- | --- | --- |
| Bun 1.4.3 | **46 → 42** | **26.0 → 37.0** | 46.2 / 39.5 → 52.5 / 44.7 | 0.7 → 0.6, after: 0.7 → 0.6 | 16 → 12 ms |
| Deno 2 | 78 → 125 | 37.6 → 39.4 | 48.2 / 46.9 → 48.1 / 46.8 | 3.7 → 3.6, after: 3.7 → 3.6 | 42 → 46 ms |
| Node 24 | 203 → 201 | 71.2 → 69.2 | **191.7 / 190.1 → 193.4 / 189.9** | 9.0 → 8.8, after: 9.0 → 8.8 | 33 → 32 ms |

- **F5 over real HTTP.** `POST /echo` is 5% of a load that is bound by the load generator, so its rate does not move; the gain is visible in-process (`bench/run.ts`, see F5). No runtime regressed and the heap is still flat on all three.
- Bun's idle RSS (26 → 37 MB) and Deno's first response (78 → 125 ms) are single cold-start samples on a shared machine; the Bun wrapper's idle RSS moved the other way (38.2 → 26.7 MB). Treat ±10 MB / ±50 ms on one cold start as noise.

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

All apps pass. After the fixes (load, then stop): core 17 ms, api 20 ms, quiz 17–19 ms, arena 22 ms; core via `app.listen` on Bun / Node / Deno 12 / 32 / 46 ms.

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

The re-soak gives the same picture: 0 in flight after the HTTP aborts in every app, and quiz again has 50 rooms with 0 connected after the WebSocket drops.

**The arena long-poll ignored client disconnects** (minor; FIXED in `6ddb1ae` and verified: the wait now ends on `ctx.req.signal` abort).

- What happened: a client queues, starts `GET /match/duel/status?wait=20000`, and vanishes after 100 ms. The handler kept waiting.
- Evidence before: one request was **still in flight 2 s after the abort**, and none only after the 20 s wait expired. See `stuck.inflight2sAfterAbort` and `inflight21sAfterAbort` in `results/bun-arena.json`.
- **After: 0 in flight 2 s after the abort** (`results/bun-arena-after.json`), so Bun's `Request.signal` does fire on client disconnect and the handler unsubscribes.
- Impact before: the wait was bounded, but a client could hold one timer and one subscription per request for the whole long-poll without keeping a socket open.

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

**Fix** (`4754301`): argon2id at 19 MiB, at most 4 hashes at once.

**Re-soak (verified):**

| Concurrent `verifyPassword` | Peak RSS above baseline, before → after | Time for the batch, after |
| ---: | ---: | ---: |
| 1 | +64 → +19 MB | 22 ms |
| 8 | +512 → +76 MB | 59 ms |
| 32 | +1,282 → +77 / +96 MB (two runs) | 223 ms |

- api: RSS peak **1,353 → 177 MB**; `register` p50/p99 195/541 → 28.5/96 ms, `login` 190/426 → 28.2/235 ms.
- The cap queues hashes instead of running them at once, so a burst of 32 sign-ins takes ~0.22 s in total.
- crm was not re-run; its 461 MB peak was measured before the fix.

### F2. `examples/api` (example code, not a package): `ranFor` grows forever (FIXED)

- **Cause.** The example's `note-created` job pushed every note title onto `ranFor`, an array kept as a hook for its tests.
- **Evidence.**
  - After 60 s the array held 112,557 strings. The settled heap went from 3.7 to 6.2 MB, with 92,729 more `string` objects.
  - With `SOAK_TRIM_RANFOR=1`, the wrapper empties the array every second. The string growth then disappears and settled growth falls from +68% to +11% (`results/bun-api-trimmed-ranFor.json`).
- **Fix.** `e6bad9c` keeps only the last 100 titles (`examples/api/app.ts:63`).
- **Re-soak (verified).** `ranFor` holds 100 entries after 60 s (was 112,557). Settled heap 6.2 → 3.9 MB, settled growth +68% → +16.5%, `string` growth +92,729 → +7,200.
- **What is left is F3.** The +16.5% is +7,626 `Object`s and +7,200 `string`s for ~1,925 users signed up after the warm-up sample: 3.96 objects per user, the limiter-window cost measured in F3. The re-soak signed up ~2,400 users in 60 s (before: ~1,450), because sign-in got cheaper. The runner's 10% rule still flags api for this reason; it is bounded by window expiry and `maxKeys`.

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

The quiz example shows the same pattern at a smaller scale: up to 360 live rooms for 40 concurrent games, all disposed after settle. quiz builds its room with `@miujs/realtime` directly, not `gameRoom`, so `closeAfterResultMs` does not apply to it; the re-soak shows the same 360 / 280 / 0 rooms (peak / end of load / settled).

**Re-soak (verified, `6ddb1ae`):**

| | Before | After |
| --- | ---: | ---: |
| Live rooms, peak during load | 34,882 | **3,091** (flat at ~3,000 ≈ 595 games/s × 5 s) |
| Live rooms at end of load | 22,726 | **0** |
| Live rooms 10 s / 20 s after load | 28,462 / 22,281 | 0 / 0 |
| Heap after GC: warm-up → end → settled | 49.1 → 131.8 → 2.8 MB | 24.3 → **3.2** → 3.0 MB |
| RSS peak / end / settled | 444 / 393 / 128 MB | **152 / 82.5 / 80** MB |

Steady-state memory is now bounded by `game rate × 5 s` instead of `× 60 s`. One room was alive at the settled sample; it was created 85 s after the load stopped and had no players. That is F7, not F4.

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

**Fix.** `fa56f78` (requests with a Content-Length) and `553cedc` (requests without one) read the body with `req.text()`.

**Re-measured** (`bun bench/run.ts`, `results/bench-after.log`, against `results/bench.log` run 3 on an idle machine):

| `POST /json (body validation → JSON)` | Before | After |
| --- | ---: | ---: |
| MiuJS req/s | 347,000 | **408,500** |
| vs best other (Elysia 373,000 / Hono 393,500) | 92% | **104%** |
| Heap per 10k requests, retained / peak | 7.6 KB / 288.1 KB | −1.4 KB / **7.8 KB** |

Over real HTTP (core soak, 5% `POST /echo`) the rate is unchanged on every runtime, because the soak is bound by the load generator, not by the body read.

### F6. Fixed by other agents during this work (verified)

- **Shutdown hang with open game timers:** fixed in `3d837b1` (see "Graceful shutdown").
- **`@miujs/realtime` `MemoryCodeStore`:** expired join codes were deleted only when someone looked them up again, so every `createRoom` kept a 6-hour code forever. The store now sweeps expired codes.
- **`@miujs/session` `memorySessionStore` and `@miujs/auth` `memoryRateLimiter`:** expired entries are now swept. The api and crm examples use cookie sessions, so the soak did not exercise the session store.

### F7. `@miujs/game` client: `findMatch` gives up without leaving the queue (new, minor; FIXED)

Found in the arena re-soak. Not a leak, but it can make empty rooms and ghost matches.

- **Cause.** When `findMatch` hits its `timeoutMs`, it throws `MIU_E_GAME_MATCH_TIMEOUT` (`packages/game/src/connect.ts:53`) without calling `DELETE /match/:queue/leave`. The server keeps the player queued until the queue's own `maxWaitMs` (120 s for arena, `packages/game/examples/arena/app.ts:39`), and can still match them in that time.
- **Evidence** (`results/bun-arena-after.json`, per-second samples):
  - After the load stopped, two clients kept long-polling (2 in flight from 65 s to 120 s) without being matched with each other.
  - At 120 s their 60 s `findMatch` timeout fired and they stopped. The server still had them queued.
  - At 145 s the matchmaker paired them: a room was created that nobody joined. It was still there at the settled sample (`settledExtras.rooms`: 1 room, 0 players).
- **Why the two were not paired sooner.** Most likely the Elo window: it starts at ±100 and widens by 100 every 5 s (`packages/game/src/queue.ts:165-167`, used at `:231-240`). After a minute of random-move games the two last players can be far apart in rating. This part is inferred: the run did not record their ratings.
- **Impact.** A real player can be matched against someone who already gave up, and then wait in a room for an opponent who never comes. The empty room is disposed by the normal empty-room timeout, so nothing is retained for long.
- **Suggested fix.** In `findMatch`, call `leave` (best effort) before throwing on timeout, and on any other early exit. The soak harness's arena client could also leave when the load stops (`scripts/soak/scenarios.ts`, arena `vu`).

### What the soak did not find

- No growth in core request handling on any runtime. On Bun the heap stayed flat over 4.17M requests (4.08M in the re-soak).
- After the fixes, nothing still grows or sticks except the bounded F3 limiter windows in api.
- No hung handler after half-sent bodies or aborted fetches, in any app.
- No room left `connected` after abrupt WebSocket drops.
- No shutdown hang at the final code.
- crm (admin UI, audit, workflows, SQLite) settled 11% *below* its warm-up heap.

## Reproduce

Run everything from the repo root, with Bun 1.4.3. Results go to `scripts/soak/results/` as `<runtime>[-listen]-<app>[-<suffix>].json`. Each file holds per-second samples, object-type diffs and per-operation latency.

```bash
# Full soak, every example on Bun (60 s each; realtime apps settle 65 s) – about 12 minutes
bun scripts/soak/run.ts
bun scripts/soak/run.ts --quick                       # 15 s each, 5 s settle
bun scripts/soak/run.ts --apps=arena --duration=120   # one app, longer

# Bare core app on each runtime via app.listen()
bun scripts/soak/run.ts --apps=core --listen
bun scripts/soak/run.ts --apps=core --runtime=node    # set NODE_BIN=... to override the path
bun scripts/soak/run.ts --apps=core --runtime=deno    # set DENO_BIN=... to override the path

# The re-soak after the fixes (writes *-after.json next to the originals)
bun scripts/soak/run.ts --apps=core,api,quiz,arena --suffix=after
bun scripts/soak/run.ts --apps=core --listen --suffix=after   # and --runtime=node / --runtime=deno

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
- `--suffix=<name>`: add `-<name>` to the result file name, so a re-run keeps earlier results.

Each result also records `machineBusyBeforePct` (whole-machine CPU in the 2 s before the app starts), `machineCpuDuringLoad` (mean and max of the per-second `cpu` samples) and a `cpu` field per sample. Runs made before this was added do not have them.

## Noise and caveats

- **Shared machine.** The load generator and the server shared a 20-thread laptop that throttles under sustained load, and other agents ran `bun test` suites during some runs. Treat absolute ops/s as ±10–15%, and compare apps or runtimes only within one table.
- **Re-soak noise.** CPU busy before each re-soaked app was 3–10%, so no other heavy job was running at the start. Other agents were still active (an uncommitted `packages/miujs/src/app.ts`, a new `packages/bots/`, a `bun` process seen between runs). quiz is the most sensitive app, because 40 games start together and ~300 WebSocket joins arrive at once. Its p99 was 32, 94 and 34 ms in three after-runs (`bun-quiz-after.json`, `-after-rerun.json`, `-after-rerun2.json`; the tables use `-after-rerun2`, the only one with per-second CPU, mean 10%). Join p95 varied from 32 to 100 ms. Its p50 and answer latency matched the original run every time, and no fix touched quiz, so treat its tail as noise. core, api, arena and the runtimes were run once each. Their numbers matched the originals where the code did not change, so they were not repeated.
- **Moving code.** Package sources changed while the soak ran (see `codeState` in each result file). The "before" tables come from the last run of each app, before the fixes for F1, F2, F4 and F5; the "after" numbers come from `2891f99`.
- **Heap metrics differ by engine.** "Heap" is JSC `heapStats().heapSize` after `Bun.gc(true)` on Bun, and V8 `heapUsed` after `gc()` on Node and Deno. The engines count differently, so compare heap *trends* across runtimes, not absolute sizes.
- **Per-second samples** in the JSON are taken without a GC first, so they include garbage as well as live data.
