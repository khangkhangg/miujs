# Security, speed and memory assessment: games and back-office apps

Date: 2026-10-16. Scope: the plugins a game or back-office app is built from. Each area was audited adversarially, each real finding was fixed test-first (the test fails without the fix), and each area was load-tested and soak-tested for leaks. Numbers are from one Windows laptop (Bun 1.4.3, 20 threads) unless marked workerd (Cloudflare's runtime, run locally).

## Verdict

| Area | Security | Speed under load | Memory and leaks |
| --- | --- | --- | --- |
| Core HTTP, auth, session, access, rate limits, bots, web | 23 findings fixed (5 high); no critical | Signed-in stack 18.5 → 9.4 µs per request (~105k req/s per core) | Flat with 2M unique clients; every store bounded |
| Games: realtime, game, quiz | 18 findings fixed (1 critical, 4 high) | One room: 6,891 msgs/s at 200 players, p99 52 ms (batched); 100 rooms × 8 players at 20 Hz: p99 51 ms | ~3 KB per idle player; 12-min soak settles to 0 rooms, 2.3 MB heap |
| Back office: admin, workflows, audit, files, queue, mail, db | 14 findings fixed (2 critical, 2 high) | Sorted lists on 100k rows < 1 ms; 100k-row CSV export 448 ms; 10-min soak 237 req/s, 0 errors | Heap flat at 10.2 MB over 10 min; export streams at flat heap |
| WebSocket transport (core) | Payload and backpressure limits; sockets no longer pin the request | — | 6.6 → 1.7 KB per socket with a 4 KB cookie |

All suites pass (4,235 tests), TypeScript is clean, and the benchmark gate passes (best of three runs).

## What was fixed

### Critical and high

- **Back office, critical: cross-tenant workflows.** Workflows built in the admin UI ran app-wide, so any org admin could fire, edit or read other orgs' workflows and write into other orgs. Now scoped to the owning org; raw `/workflows` routes refuse org-scoped requests (`MIU_E_WORKFLOWS_ORG_SCOPED`).
- **Back office, critical: SSRF.** The workflow `http` action reached private and cloud-metadata addresses and followed redirects. Private ranges are blocked on every hop, with size and time caps.
- **Games, critical: msgpack bomb.** A 6-byte frame made the server allocate ~800 MB. Lengths are checked before allocating.
- **Back office, high:** cubic ReDoS in workflow templates (a 10 KB string blocked the server for 91 s); `/workflows` routes allowed the same cross-org access.
- **Games, high:**
  - Plugin MCP tools listed every room and its raw state to anyone.
  - The first joiner became host.
  - Joining any id created a room.
  - Kicked players could rejoin.
- **Core, high:**
  - MCP and AI tool arguments with `..` reached other routes.
  - MCP was open to DNS rebinding.
  - Cookie-bearing responses could enter the bot cache and be served to crawlers.
  - NTFS short names served `.env` on Windows.
  - The Node adapter let the Host header rewrite the path.

### Medium and low (summary)

- **Core and identity:**
  - invalid `auth` values compiled to public routes;
  - cross-site WebSocket hijacking;
  - `__proto__` in query, form and cookies;
  - API tokens could mint more tokens;
  - passkeys and OAuth links survived a password reset;
  - made-up API keys got their own rate-limit buckets;
  - `javascript:` URLs and unquoted attributes in templates;
  - unbounded memory session and cache stores;
  - CSP nonces cached for bots.
- **Games:**
  - lobby code brute force and create floods;
  - join codes held after a room closed;
  - leaderboard proof replay across isolates;
  - member, idle-socket and per-IP connection caps;
  - silent frame drops for slow readers;
  - handler errors leaked to clients;
  - display-name impersonation.
- **Back office:**
  - `include=` and the CRM timeline ignored row-level policies;
  - admin pages had no CSP or frame protection without `secureHeaders()`;
  - mail recipient injection through display names;
  - audit redaction gaps;
  - forged audit checkpoints;
  - the queue kept starting jobs after `close()`;
  - unbounded note lists in the API example.

Every fix site was mutation-checked (the fix reverted, the test confirmed to fail). A 192-case matrix proves the per-route fast path never skips auth, permission or validation.

## Load and memory details

- **Signed-in request stack** (session + auth + access + rate limit + bots, with a permission check): 9.4 µs per request. Remaining cost: the access membership query in SQLite.
- **Games:**
  - 93% of broadcast CPU is the native `ws.send` (~8 µs per frame), so frame count is what matters. `patchBatchMs` coalesces patches; without it a 200-player room manages 569 msgs/s at p99 512 ms.
  - Seating 1,000 quiz players on workerd: 2.6 s and 2,000 frames.
  - Room snapshots on Durable Objects are coalesced and chunked (13 writes instead of 2,002 at 1,000 players).
- **Back office:**
  - 3 SQL statements per list request (4 with `include`), so no N+1 queries.
  - Per-org sort indexes; CSV import of 5k rows in 1.15 s.
  - Audit appends use group commit.
  - Common-word search is ~15 ms on 100k rows and is the main CPU cost under load.
- **Shutdown:** game and back-office processes exit 15–35 ms after `close()`.

## Decisions for you

1. **Logout with cookie-only sessions.** A copied session cookie keeps working until it expires. Options: use a server-side session store (recommended for back offices), or add "log out everywhere" through a session version.
2. **`__Host-` cookie prefix by default.** Safer against cookie tossing from subdomains, but switching the default signs every existing user out once.
3. **Unknown client IP.** Behind a proxy without `trustProxy`, and for in-process AI tool calls, all requests share one rate-limit bucket. Set `trustProxy`, and use `by: "user"` for AI tool routes.
4. **Rate limits on export, import and bulk.** The admin README shows a `@miujs/ratelimit` rule. The CRM example doesn't apply one yet.

## Still open

- **Search:** common-word and short-prefix search costs O(matches). Fix with an FTS5 prefix index or a minimum prefix length.
- **Value-range filter regression:** one admin filter (a value range) got slower, 0.43 → 7.1 ms, because the planner now prefers the new sort index.
- **No retention:** the audit log and workflow runs have none. A 10-minute soak grew the database to 640 MB.
- **Workflow queue:**
  - each emitted event costs 3 statements;
  - check that runs still queued in memory resume after a restart.
- **Uploads and queues:**
  - large multipart uploads are size-checked only after assembly;
  - dead letters in durable queues grow without bound.
- **Cold start:** about 5% slower relative to Elysia and Hono after the security checks (still ~11 ms).
- **Needs a real Cloudflare account:** edge bot scores, CPU limits, Durable Object hibernation with open sockets, and Queues at scale.

## How to reproduce

```bash
bun test                                   # all suites
bun bench/run.ts && bun bench/compare.ts   # speed vs Elysia and Hono, CI gate
bun scripts/soak/games.ts soak             # game soak (rooms, resumes, memory)
bun scripts/soak/backoffice-soak.ts        # back-office soak (CRM traffic over HTTP)
bun run workerd                            # example apps on Cloudflare's runtime, locally
```
