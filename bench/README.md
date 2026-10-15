# Benchmarks

```bash
bun bench/run.ts            # 3 rounds × 2 s per framework and scenario, then memory and cold start
BENCH_MS=500 bun bench/run.ts
BENCH_HTTP=1 bun bench/run.ts  # also GET / over real HTTP (Bun.serve on 127.0.0.1)
```

For real-HTTP/WebSocket soak tests of the example apps (memory over time, latency percentiles,
shutdown), see [`scripts/soak/REPORT.md`](../scripts/soak/REPORT.md).

## Method

- Each framework's fetch handler is called **in-process** with identical `Request` objects, and
  the response body is read. On Bun all three would sit behind the same `Bun.serve`, so this
  isolates what the framework itself costs: routing, validation and building the response.
- Before timing, a check confirms all three apps return identical bodies.
- Frameworks are **interleaved within each round** and the order rotates, so CPU frequency drift
  or thermal throttling hits all of them equally. The best round is kept.
- Hono has no built-in validator, so its `/json` route validates by hand, doing the same checks.
- **Memory** (heap per 10k requests, in-process, best of 2 interleaved rounds):
  - *retained*: live-heap growth per 10k requests after a full GC, measured with `leakCheck`
    from `scripts/lib/leak.ts`. A healthy framework is ~0.
  - *peak*: the highest heap size above the post-GC baseline while serving 10k requests,
    sampled every 500 requests. JSC collects young garbage on its own schedule, so treat this as
    approximate garbage pressure, not an exact allocation count.
- **`GET /` with the server argument**: Bun.serve calls `fetch(req, server)`. The main table calls
  `fetch(req)` the way a test does, which keeps MiuJS's `content-type` header on text responses.
  An extra row passes a real Bun `Server` object as the second argument (Elysia ignores it, Hono
  receives it as `env`), which is what `export default app` and `app.listen()` do on Bun.
- **Over HTTP** (`BENCH_HTTP=1`, `GET /` only): each framework behind its own `Bun.serve` on
  127.0.0.1, with load from Worker threads running keep-alive `fetch` loops (default 2 workers × 32
  connections; `BENCH_HTTP_CLIENTS`, `BENCH_HTTP_CONC`), plus a bare `Bun.serve` returning
  `new Response("Hi")` as the ceiling. Before timing, it checks that every framework returns `Hi`
  with a `text/plain` content-type on the wire. On Windows, more than ~64 connections made Bun's
  loopback throughput collapse (14–22k req/s), so keep the defaults there.
- **Cold start**: `bench/cold.ts` in a fresh `bun` process: runtime boot, importing the framework,
  building the same 3-route app and reading one response. Median of 7 interleaved runs.

## CI regression gate

```bash
bun bench/run.ts --json bench-1.json          # also write the results as JSON
bun bench/compare.ts bench-1.json [more.json] # compare with bench/baseline.json; exit 1 on a regression
bun bench/compare.ts --update a.json b.json c.json   # write a new baseline (per-metric median run)
```

The `bench` job in `.github/workflows/ci.yml` fails a PR when MiuJS regresses any benchmark by
more than 5%. Absolute req/s depend on the runner, so every metric is a **ratio measured in the
same run**: MiuJS req/s ÷ the best of Elysia and Hono for each throughput row (`GET /`,
`GET /users/:id`, `POST /json`, `GET /` with the server argument), and best other cold start ÷
MiuJS cold start. A metric fails when it drops below 95% of the baseline ratio. Noise handling:
each run keeps the best of 5 interleaved rounds (`BENCH_ROUNDS=5 BENCH_MS=1000`, cold start median
of 15 with `BENCH_COLD_RUNS=15`); when the gate fails, CI runs the benchmark again (up to 3 runs)
and each metric keeps its best ratio, so a single noisy run cannot fail a PR but a real regression
fails all three. Retained heap is ~0 for every framework, so a ratio would be noise: instead it
must stay under 64 KB per 10k requests (a leak grows linearly). The logic is unit-tested in
`bench/compare.test.ts`.

On this laptop single runs of the same code move up to ±5% per ratio (three runs: `GET /users/:id`
95.4% / 101.6% / 100.5%), which is why one run alone is not trusted. **`bench/baseline.json` was
recorded on Windows** (the per-metric median of three runs). Linux ratios may differ; if the first
CI run on `ubuntu-latest` fails only because of that, refresh the baseline from the uploaded
`bench-results` artifact (`bun bench/compare.ts --update bench-*.json`).

## Fast paths without code generation (2026-10-15, latest)

Goal: close the gap to Elysia on the trivial routes without `new Function`. Same laptop (Bun
1.4.3, Windows 11). "Before" is the previous code, "after" this change; each pair ran back to
back, interleaved, ratios vs the best other framework (Elysia in every trivial row):

| Row | Before (6 runs) | After (6 runs + 3 baseline runs) |
| --- | --- | --- |
| `GET /` text, `fetch(req)` | 79 / 77 / 73 / 74 / 74 / 74% | 86 / 90 / 87 / 87 / 89 / 81%; 85 / 91 / 86% |
| `GET /` text, `fetch(req, bunServer)` | 90 / 91 / 86 / 91 / 91 / 87% | 83 / 98 / 88 / 100 / 98 / 92%; 93 / 98 / 101% |
| `GET /users/:id` | 84 / 84 / 86 / 85 / 90 / 87% | 103 / 103 / 98 / 100 / 95 / 100%; 95 / 102 / 101% |
| `POST /json` | 114 / 88 / 104 / 103 / 98 / 104% | 105 / 94 / 106 / 110 / 104 / 104%; 105 / 111 / 105% |

(Runs 1–3 of each column are full `bench/run.ts` runs at 2 s × 3 rounds; runs 4–6 the throughput
part only; the baseline runs used 1 s × 5 rounds. The first three "after" runs predate the router
change below.) Memory and cold start did not change: retained heap −1.4 to 1.3 KB per 10k requests
for every row, cold start 11.1–12.4 ms vs Elysia 50.5–61.0 ms and Hono 12.9–15.4 ms.

What changed, each kept only if it measured (`Bun.nanoseconds()` microbenchmarks, best of 5 × 300k
requests, plus `bun --cpu-prof-md`):

- **Per-route specialization by closure selection** (`compile()`). A route with no auth,
  permission, query or body gets a `run` that is just "call the handler, convert the result"; with
  a params schema it adds only the params check. The generic `run → validated → callHandler` chain
  stays for everything else.
- **Params copy skipped when it cannot change anything.** A `t.object` whose fields are all plain,
  required `t.string()` (recognized by identity of the parser `t.string()` uses without
  constraints, and by a WeakSet of objects `t.object` itself built; a spread copy or custom `parse`
  never qualifies), with the router writing keys in the same order, and no `onRequest` hook that
  could replace `ctx.params` first. The router always yields one string per declared key, so the
  check would return an equal object.
- **Text responses from a per-route cached Response.** When a route returns the same string as
  last time, it returns `template.clone()` instead of `new Response(text, { headers })`: ~60–85 ns
  less on Bun, and the clone keeps its `content-type` after the body is read and has its own,
  mutable headers. Texts over 1 KB are built (cloning costs more from ~1–4 KB).
- **Route before context.** The router runs before the context exists, so `ctx.route` and
  `ctx.params` are constructor fields (one object shape from the start, no transition), `runtime`
  is a prototype getter, and the no-hook, matched, non-HEAD case calls `match.run` directly.
- **Cheaper `fetch`/`after`.** `fetch(req)` goes straight to dispatch; the same Bun server as last
  time skips the platform checks; "no response hooks and no request logging" is computed once.
- **`GET` router in a field**, not a Map lookup per request.
- **Static paths with a unique length** match with one string comparison instead of hashing the
  path for the Map (`/` lookup 13 → 4 ns).
- **`pathOf`** uses native `indexOf`s and skips the scheme scan for `http://`/`https://` (10–20 ns).

Tried and dropped: not allocating `ctx.params` for static routes (no measurable change).

## Text responses on Bun.serve (2026-10-15, late night)

MiuJS now leaves `content-type` off a string Response when it goes straight to Bun's server and
nothing can see the object (rule in "What still blocks", item 1). Bun adds
`text/plain;charset=utf-8` on the wire. Same machine as below, `BENCH_HTTP=1`, two full runs with
the new branch disabled ("before") and two with it enabled ("after"), all back to back:

| `GET /` text | MiuJS before (run 1 / 2) | MiuJS after (run 1 / 2) | vs best other, before | vs best other, after |
| --- | ---: | ---: | ---: | ---: |
| In-process `fetch(req)` (main table; this path is unchanged) | 1,382,000 / 1,383,000 | 1,279,500 / 1,460,500 | 70% / 75% | 70% / 79% |
| In-process `fetch(req, bunServer)` | 1,249,500 / 1,252,500 | 1,406,000 / 1,487,000 | **72% / 72%** | **85% / 84%** |
| Over HTTP, 2 × 32 connections | 70,273 / 70,626 | 71,989 / 71,869 | 99% / 97% | 101% / 98% |

Elysia was the best other framework in every in-process row (1.66M–1.96M req/s). Over HTTP all
three frameworks were within 3% of each other and of a bare `Bun.serve` (71.6k–73.0k req/s).

- The gain shows where expected: with Bun's server as the second argument, `GET /` went from 72%
  to 84–85% of Elysia (about +12 points, in line with the earlier experiment's 87%).
- The main `fetch(req)` table uses the unchanged path (the header is still set). It moved only
  within the usual ±5-point noise.
- **Over HTTP the change is not measurable on this machine.** Bun's HTTP server on Windows
  loopback tops out at ~72k req/s even with no framework (~14 µs per request). A ~0.12 µs saving
  is far below that noise, and every framework sits at the ceiling. Seeing framework differences
  over the wire would take a faster load generator or Linux.
- Memory and cold start did not change (cold start 11.3–11.8 ms for MiuJS vs 50.8–54.5 ms for Elysia).

## Earlier results (2026-10-15, night)

Bun 1.4.3 on Windows 11, laptop CPU (20 logical cores), MiuJS after the body-read fix below. Two
back-to-back runs on an otherwise idle machine. Absolute req/s move ±10% between runs for every
framework, so **compare within a row, not across rows or runs**.

| Scenario | MiuJS | Elysia 1.4.30 | Hono 4.13.13 | MiuJS vs best other (run 1 / 2) |
| --- | ---: | ---: | ---: | ---: |
| `GET /` text | 1,348,000 | 1,824,000 | 1,555,000 | 74% / 70% |
| `GET /users/:id` params → JSON | 945,000 | 1,145,500 | 712,000 | 82% / 90% |
| `POST /json` body validation → JSON | 398,500 | 364,000 | 382,500 | **104% / 103%** |

(req/s from run 1.)

Heap per 10k requests (retained after GC / peak above baseline):

| Scenario | MiuJS | Elysia | Hono |
| --- | ---: | ---: | ---: |
| `GET /` text | −1.4 KB / 1.0 KB | −1.8 KB / 0.0 KB | −1.4 KB / 1.4–1.8 KB |
| `GET /users/:id` | −0.2 KB / 1.3 KB | 1.3 KB / 0.3–0.8 KB | 1.3 KB / 2.3–3.4 KB |
| `POST /json` | 1.3 KB / 8.5–9.3 KB | 1.1 KB / 5.5–6.6 KB | 1.3 KB / 12.0–12.7 KB |

Retained heap is ~0 for every framework and route (no leak). Peak heap is now level across all three.

| | MiuJS | Elysia | Hono |
| --- | ---: | ---: | ---: |
| Cold start, process start → first response (median ms; runs 1 / 2) | 11.6 / 11.3 | 52.9 / 52.5 | 13.9 / 13.4 |

Summary: MiuJS starts fastest (about 4.6× faster than Elysia, ahead of Hono), is fastest when
validating JSON bodies, matches the others on memory, and trails Elysia by 10–18% on the params
route and ~28% on the text route (see "What still blocks" below).

**`POST /json` regression: fixed.** Since `5aae15e` (body limits) JSON bodies were read with
`arrayBuffer()` and then `TextDecoder.decode`, which is slower than `req.text()` on Bun and doubled
the garbage (265–288 KB peak per 10k requests). Bodies are now read with `req.text()`. With a
`Content-Length` the limit is checked before reading. Without one the limit is checked on the text,
counting UTF-8 bytes exactly only when the length is within 3× of the limit. Memory stays bounded
by the server's own body cap, as before.

### Earlier results (2026-10-15, evening)

Bun 1.4.3 on Windows 11, laptop CPU (20 logical cores), MiuJS at `3d837b1`. Three full runs:
runs 1 and 2 back to back while other agents' `bun test` jobs were probably still running on
the same machine, and run 3 when it was otherwise idle. The machine throttles, and absolute req/s
move ±10% between runs for **every** framework (Hono's `GET /` ranged 1.47M–1.62M), so
**compare within a row, not across rows or runs**.

| Scenario | MiuJS | Elysia 1.4.30 | Hono 4.13.13 | MiuJS vs best other (run 1 / 2 / 3) |
| --- | ---: | ---: | ---: | ---: |
| `GET /` text | 1,481,500 | 1,880,000 | 1,469,000 | 79% / 75% / 71% |
| `GET /users/:id` params → JSON | 1,021,500 | 1,204,500 | 720,000 | 85% / 83% / 84% |
| `POST /json` body validation → JSON | 339,500 | 384,000 | 406,500 | 84% / 91% / 92% |

(req/s from run 1.)

Heap per 10k requests (retained after GC / peak above baseline; same in all three runs within noise):

| Scenario | MiuJS | Elysia | Hono |
| --- | ---: | ---: | ---: |
| `GET /` text | 7.6 KB / 1.0 KB | 7.2 KB / 0.0 KB | 7.6 KB / 2–7 KB |
| `GET /users/:id` | 7.6 KB / 0.9 KB | 7.6 KB / 1.2 KB | 1.3 KB / 4–5 KB |
| `POST /json` | 7.6 KB / **288 KB** | 7.4 KB / 4–11 KB | 7.6 KB / 11–14 KB |

The ~7.5 KB *retained* figure is the same for all three frameworks and every route. It is the
noise floor of the measurement (under 1 byte per request), not a leak. *Peak* is low everywhere
except MiuJS `POST /json`, which creates ~25× more short-lived heap than the others (see below).

| | MiuJS | Elysia | Hono |
| --- | ---: | ---: | ---: |
| Cold start, process start → first response (median ms; runs 1 / 2 / 3) | 11.0 / 11.4 / 10.9 | 49.0 / 50.3 / 50.0 | 12.3 / 12.9 / 12.5 |

Summary: MiuJS starts fastest (about 4.5× faster than Elysia, slightly ahead of Hono), is level with
Elysia and Hono on memory for GET routes, and trails Elysia by 15–17% on the params route and
21–29% on the text route.

**`POST /json` regressed** (fixed since; see above) from 106–111% of the best other framework (the 11:20 run below) to
84–92%. Elysia and Hono did not move, so this is MiuJS's own change. Cause: since `5aae15e`
(12:12, body limits) `readBody` reads JSON with `new Uint8Array(await req.arrayBuffer())` and
then `TextDecoder.decode`. On Bun 1.4.3 that path costs ~1,450 ns per request versus ~1,100 ns
for `req.text()` and ~960 ns for `req.json()` (A/B microbenchmark, 300k requests × 3 rounds,
each figure including `new Request`). It also explains the 288 KB peak heap. When a
`Content-Length` header is present and within the limit, `req.text()`/`req.json()` would keep the
limit and skip the copy. That change is in `packages/miujs/src/app.ts`, which this benchmark
does not touch.

### Previous results (2026-10-15, 11:20)

Bun 1.4.3 on Windows 11, laptop CPU. This machine throttles during long runs, so absolute
req/s drift between runs for every framework. **Compare within a row, not across rows.**
Two back-to-back runs after the dispatch-path work:

| Scenario | MiuJS | Elysia 1.4.30 | Hono 4.13.13 | MiuJS vs best other (run 1 / run 2) |
| --- | ---: | ---: | ---: | ---: |
| `GET /` text | 1,444,500 | 1,931,500 | 1,582,500 | 75% / 72% |
| `GET /users/:id` params → JSON | 1,017,000 | 1,127,000 | 672,500 | 90% / 82% |
| `POST /json` body validation → JSON | 438,500 | 363,000 | 393,500 | 111% / 106% |

(req/s from run 1. Before this work the same rows were 77%, 70% and 99% of Elysia.)

At that point MiuJS beat Elysia and Hono when validating request bodies (it no longer does; see
above), was within 10–18% of Elysia on a params route, and trailed Elysia by about 25% on a text
route. The spec targets "within 10% of Elysia": the params row is at the edge, and the text row
is not there. See below for why.

## Where the time goes (measured)

Per-piece costs from microbenchmarks (`Bun.nanoseconds()`, 5M iterations, JIT warm):

| Piece | Cost |
| --- | ---: |
| `new Request(...)` (paid by the caller, same for all) | ~165 ns |
| `Response.json(...)` (same call in Elysia) | ~250–400 ns |
| `new Response(string)`, no headers (what Elysia returns) | ~230–290 ns |
| `new Response(string, { headers: sharedHeaders })` (MiuJS) | ~340–400 ns |
| `new Response(string, { headers: { ... } })` (MiuJS before) | ~510–580 ns |
| Router, `/users/:id` on a fresh path string (memoirist: same) | ~100 ns |
| Request context creation | ~35–50 ns |
| `req.url` + path extraction | ~30 ns |
| Params validation `t.object({ id: t.string() })` | ~40 ns |

Framework dispatch alone (handler returns a prebuilt `Response`): MiuJS ~150–180 ns vs Elysia
~100 ns on `/`, and ~300–360 ns vs ~210–240 ns on `/users/:id`.

### What changed (2026-10-15, from `bun --cpu-prof-md` profiles)

- **Text responses:** `new Response` was 51% of `GET /` self time. A plain-object `headers`
  init is rebuilt into a `Headers` on every call. Passing a shared `Headers` instance (Bun copies
  it, so it is never mutated) saves ~130 ns per text response.
- **Router:** `find` was ~21% of `GET /users/:id`, mostly `path.split("/")`. The walk now scans the
  path string by index, compares short static child lists with `startsWith` (no slice, no hash),
  skips the static `Map` when no static route has that length, and writes params straight into
  `ctx.params` (no match object). It now runs as fast as memoirist.
- **Allocations per request:** the platform object is reused instead of built per request, the
  validation `issues` array is reused while validation passes, object schemas reuse child path
  strings (`"params.id"`), and `RequestContext` sets 8 fields instead of 20 (rarely-set defaults
  live on the prototype).
- Plain-object handler results skip the `instanceof` chain in `toResponse`.

### What still blocks "within 10%" on trivial routes

1. **`content-type` on text responses (~110–130 ns, ~12–15 points on `GET /`). Resolved for
   Bun.serve (late night).** MiuJS now builds a string Response without headers when all of these hold:
   - the request came from Bun's own server (`export default app` or `app.listen()` on Bun), and
     the second argument's `Object.prototype.toString` tag is Bun's `HTTPServer`/`HTTPSServer`,
     not a look-alike;
   - no plugin has `onResponse`;
   - the method is not `HEAD` (Bun adds no content-type to a bodyless HEAD response);
   - the route set no headers.

   In that case Bun adds the content-type on the wire. Every path that can read the object keeps
   the header: `app.fetch(req)`, `app.tools()`, MCP and any `app.dispatch`, which swaps the
   wire-only platform for the normal one. Node, Deno and Workers also keep it.
   Original analysis: Elysia returns
   `new Response("Hi")`, which on Bun has *no* `content-type` on the Response object (Bun.serve adds
   one on the wire). MiuJS sets `text/plain; charset=utf-8` on the object so tests, plugins and
   the Node/Workers adapters see it. With that header removed as an experiment, `GET /` went from
   ~73% to **87%** of Elysia. Cheaper ways to get the header don't hold up: a shared `Blob` body is
   as fast as a bare string, but Bun derives its `content-type` lazily, so the header disappears
   once the body is read, which breaks `app.call()`. (A later measurement put `clone()` of a cached
   template Response at ~60–85 ns cheaper than building one with headers, not ~25 ns; it is now used, see
   "Fast paths without code generation".)
2. **Dispatch overhead (~50–80 ns more than Elysia).** It is spread across many small pieces, each
   10–30 ns (context object, path extraction, the validated-params copy, hook and promise checks),
   with no single hotspot left in the profile. Elysia generates one specialized function per route
   with `new Function`. MiuJS cannot (Workers forbid it; see AGENTS.md), so it pays a few generic
   branches per request instead.

Item 1 is now resolved for Bun.serve, as described above. The `fetch(req)` table still pays for the
header by design, since tests and adapters use that path.

**Remaining gap after the fast paths (2026-10-15, latest).** Per request, from microbenchmarks
(`new Request` + handler + `await res.text()`; "floor" is a function returning `new Response("Hi")`):

| `GET /` | ns | over floor |
| --- | ---: | ---: |
| floor | 426–462 | — |
| Elysia | 498–540 | ~55–95 |
| MiuJS `fetch(req, bunServer)` | 527–560 | ~90–120 |
| MiuJS `fetch(req)` | 619–676 | ~180–230 |
| MiuJS `fetch(req)` with the header dropped (experiment only) | 574 | ~150 |

- **`fetch(req)` text, ~81–91% of Elysia: the header is the cap.** Keeping `content-type` on the
  Response object costs ~60–85 ns even with the cached-template `clone()`; dropping it as an
  experiment moved the microbenchmark ratio from 0.83 to 0.91. 95% is not reachable here without
  removing a header that `app.fetch`/`app.call` users, plugins and the Node/Workers adapters can see,
  so it stays.
- **Dispatch, ~30–50 ns more than Elysia.** Elysia's generated `map(r)` is one straight-line
  function: a string `switch` on the path, an inline method `switch`, a plain object literal as
  context, and the handler called directly. MiuJS without codegen makes 4 calls instead (`fetch` →
  `dispatchCore` → the route's closure → the result converter), builds a class instance, and its
  `pathOf` handles `#` and every URL scheme (Elysia's `indexOf('/', 11)` misreads hosts shorter
  than four characters). No piece is over ~10 ns in the profile now. For fairness: Elysia's
  `handle()` is `async`, so it also pays one promise per request in this benchmark, which MiuJS
  (synchronous for sync handlers) does not.
- With Bun's server as the argument (no header), `GET /` is at 92–101% in most runs and
  `GET /users/:id` at 95–103%; the spread is the machine's run-to-run noise (±5%).
