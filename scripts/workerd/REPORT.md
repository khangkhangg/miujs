# MiuJS on workerd (local): report

`bun run workerd` runs the example apps on Cloudflare's own runtime, locally. For each app it generates `wrangler.toml` with `miu deploy cloudflare --dry-run`, starts `wrangler dev --local` on a free port (workerd plus Miniflare's local D1, KV, R2, Queues, Durable Objects, Workflows, rate limits and Cache API), and drives real HTTP and WebSocket scenarios against it. No account, no login, no `--remote`, no deploy. `request.cf` is Miniflare's placeholder (`CLOUDFLARE_CF_FETCH_ENABLED=false`), so runs need no network after install.

All numbers are **local**: one Windows 11 x64 laptop, wrangler 4.143.1, workerd 2026-09-26, Bun 1.4.3, Node 24.22. The client runs on the same machine and every request goes through wrangler's local proxy. They show relative cost and catch regressions; they are not edge numbers.

```bash
bun run workerd                    # every suite + bundle sizes (≈6 min, mostly the 1,000-player quiz)
bun run workerd quiz --players 200 # one suite, smaller fan-out
bun scripts/workerd/bundle.ts      # bundle sizes only
```
Results go to `scripts/workerd/.out/` (`results.json`, each app's generated `wrangler.toml` and wrangler log). CI runs the harness as the `workerd` job (200 quiz players).

## Layout
| Path | What |
|---|---|
| `run.ts` | config generation → `wrangler dev --local` → suite → stop; writes `.out/results.json` |
| `lib.ts` | Node/wrangler discovery and install, workspace links for the fixtures, wrangler start/stop, cookie-jar HTTP client, MCP and Local Explorer helpers, percentiles, workerd RSS |
| `bundle.ts` | esbuild (wrangler's copy), `workerd` conditions, minified + gzip |
| `scenarios/*.ts` | one suite per app |
| `apps/core`, `apps/cold` | core only; core + session + auth + cache |
| `apps/kitchen` | R2 files, Queues job + cron, Rate Limiting binding, DO rate limiter, bots + Cache API, KV sessions, Cloudflare Workflows |
| `package.json`, `bun.lock` | wrangler 4.143.1 (not a workspace) |

On Windows, workerd needs the Visual C++ runtime. If it is missing, `lib.ts` copies Microsoft's DLLs from an installed Office/ClickToRun next to `workerd.exe`, inside `scripts/workerd/node_modules` only. There is no tour example in the repo, so `@miujs/tour` is not covered.

## Results: 70 passed, 0 failed, 0 skipped
| App | Scenarios | Result |
|---|---|---|
| all 7 | config generation; `wrangler dev --local` starts | pass |
| core | cold start, params + validation, 413, MiuError/404, multiple Set-Cookie, ctx.ip, waitUntil, MCP, `ctx.upgrade` WebSocket | 9 pass |
| cold | 5 fresh starts (core + session + auth + cache) | pass |
| api | D1 migrations, PBKDF2 register/login (600k iterations stored), CSRF, validation, D1 CRUD + isolation, KV cache + invalidation, Queues, API token → MCP, latency, logout | 11 pass |
| quiz | HTML (Text module), KV join codes, 426/404, host + 2 players over DO WebSockets, MCP room_state, 1,000-player broadcast (host action + DO alarm), state/resume/alarm survive a workerd restart | 7 pass |
| kitchen | R2 CRUD, signed GET (tamper → 403) and PUT (size enforced), upload sniffing; Queues job, retry + backoff, cron via `/__scheduled`; ratelimit binding 5/10 s → 429; DO limiter exact 3/min; bots via Cache API (miss → hit), UA paths, cf signals via `MF-CF-Blob`; KV sessions; Cloudflare Workflows (steps + sleep) | 14 pass |
| arena | 401, matchmaker DO, ticket gate, turn checks, Elo/achievement/game.over, profile/leaderboard from D1, MCP, notify WebSocket | 7 pass |
| crm | admin login, D1 records + escaping + CSP, audit rows, workflow through Queues, System area (403 → operator, org-scoped refusal, settings saved in `admin_system_settings`, D1 row applied within TTL) | 6 pass |

## Numbers (local)
| Target | Measured | Notes |
|---|---|---|
| Core bundle < 60 KB gzip | **16.2 KB** (44.7 KB minified) | +session+auth+cache 45.0; api 59.1; arena 59.7; quiz 39.5; kitchen 62.2; **crm 168.9** |
| Cold start (core+auth+session+cache) | ready p50 1,331 ms; **first request p50 29.8 ms** (max 31.3); warm p50 2.9 ms | core only: first 14.4 / warm 1.8 ms; api with D1 migrations: first 28.3 ms |
| D1 CRUD with session | **p50 5.9 / p95 8.0 / p99 9.3 ms** | 600 sequential requests |
| Quiz broadcast, 1,000 players | host action **p50 25.7 / p95 36.8 ms** (was 42 / 61); DO alarm p50 128 / p95 144 ms after the deadline | presence batched, players get a per-player view |
| Seating 1,000 players | **2.6 s, 2,000 frames** (was 198 s, 501,500 frames) | join/leave changes reach other members as one patch per 50 ms window |
| Memory | workerd RSS 153 → **1,295 MB** with 1,000 WebSockets (was 1,387) | whole local runtime, not one isolate |
| Room DO snapshot writes, 1,000 players | **13 writes, 1.2 MB** (was 2,002 full writes, 301.6 MB) | coalesced per second, sections rewritten only when changed, chunked under the value limit; measured on Bun with the real DO class and a counting storage |
| PBKDF2 600k | register 257 ms, login 246 ms (wall) | CPU limits are not enforced locally |

## Bugs fixed
1. Workflows never ran on Cloudflare: their consumer filtered on `miu-workflows` while the CLI names the queue `<app>-workflows-queue` (`packages/queue/src/cloudflare.ts`).
2. `MIU_GAME_SECRET` was never read on Workers (`gameSecretFor`, matchmaker DO env, `room.env`).
3. The quiz example read its HTML at module load ("Invalid URL string"); it now uses a text import.
4. CRM tables were missing on D1 because `admin()` only auto-migrates in dev; the example passes `kit.migrations` to `db()`.
5. `cache()` declared no KV binding, so it fell back to per-isolate memory on Workers.
6. CLI:
   - `--compatibility-date`, with the default capped at the local workerd
   - `[assets]` path made relative to the config file
   - `<app>-<binding>` resource names
   - `MIU_GAME_SECRET` listed as a secret
   - `cloudflare:workers` stand-ins so Workflow/DO entry files load

## Fixed after the first run
- **Quiz join fan-out was O(N²) frames.** Presence changes are batched (`presenceBatchMs`, default 50) and quiz players get their own view instead of the roster.
- **The room DO wrote its full snapshot on every message** and failed silently past the 2 MB value limit (near 9k players). Writes are now coalesced (`persistMs`, default 1000), split into sections that are rewritten only when changed and chunked under the value limit. Failures are logged as `MIU_E_ROOM_PERSIST_FAILED` and retried, and snapshots over `maxSnapshotBytes` raise `MIU_E_ROOM_STATE_TOO_LARGE`. At 10k players: 3.04 MB in 53 keys, 0 failures.
- **`createCloudflareWorkflow` without `base` failed on workerd.** It now loads `WorkflowEntrypoint` from `cloudflare:workers` on workerd.
- **The harness ran wrangler on Bun's `node` shim under `bun run`**, which broke wrangler's local proxy (`getaddrinfo ENOTFOUND dummy`). `nodeBin()` now rejects Bun's shim.

## Not fixed
- PBKDF2 at 600k iterations costs ~250 ms CPU per hash. `@miujs/auth` now warns on workerd and declares `[limits] cpu_ms` for `miu deploy cloudflare`; on the Free plan (10 ms) use fewer iterations, passkeys or OAuth.

## Needs a real Cloudflare account
- Edge bot score / verified bots / JA3-JA4 / geo (locally a placeholder: score 99, US; overridden per request with `MF-CF-Blob`).
- CPU, memory and subrequest limits; isolate eviction.
- Real DO hibernation with sockets kept open (only a full restart was tested).
- Queues at scale: batching, redelivery, max_retries, DLQ, concurrency.
- Cron firing on schedule.
- KV eventual consistency, D1 read replicas, R2 presigned S3 URLs.
- Edge latency, cold starts on the network, multiple locations and DO placement.
- Rate-limit accuracy per location.
- Workers AI, Vectorize, Hyperdrive.
- Resource auto-provisioning on `wrangler deploy`.
