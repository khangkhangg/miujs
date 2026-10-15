# Benchmarks

```bash
bun bench/run.ts            # 3 rounds × 2 s per framework and scenario
BENCH_MS=500 bun bench/run.ts
```

## Method

- Each framework's fetch handler is called **in-process** with identical `Request` objects, and
  the response body is read. On Bun all three would sit behind the same `Bun.serve`, so this
  isolates what the framework itself costs: routing, validation and building the response.
- Before timing, a check confirms all three apps return identical bodies.
- Frameworks are **interleaved within each round** and the order rotates, so CPU frequency drift
  or thermal throttling hits all of them equally. The best round is kept.
- Hono has no built-in validator, so its `/json` route validates by hand, doing the same checks.

## Latest results (2026-10-15)

Bun 1.4.3 on Windows 11, laptop CPU. This machine throttles during long runs, so absolute
req/s drift between runs for every framework. **Compare within a row, not across rows.**
Two back-to-back runs after the dispatch-path work:

| Scenario | MiuJS | Elysia 1.4.30 | Hono 4.13.13 | MiuJS vs best other (run 1 / run 2) |
| --- | ---: | ---: | ---: | ---: |
| `GET /` text | 1,444,500 | 1,931,500 | 1,582,500 | 75% / 72% |
| `GET /users/:id` params → JSON | 1,017,000 | 1,127,000 | 672,500 | 90% / 82% |
| `POST /json` body validation → JSON | 438,500 | 363,000 | 393,500 | 111% / 106% |

(req/s from run 1. Before this work the same rows were 77%, 70% and 99% of Elysia.)

Summary: MiuJS beats Elysia and Hono when validating request bodies, is within 10–18% of Elysia
on a params route, and trails Elysia by about 25% on a text route. The spec targets "within 10%
of Elysia": the params row is at the edge, and the text row is not there. See below for why.

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

1. **`content-type` on text responses (~110–130 ns, ~12–15 points on `GET /`).** Elysia returns
   `new Response("Hi")`, which on Bun has *no* `content-type` on the Response object (Bun.serve adds
   one on the wire). MiuJS sets `text/plain; charset=utf-8` on the object so tests, plugins and
   the Node/Workers adapters see it. With that header removed as an experiment, `GET /` went from
   ~73% to **87%** of Elysia. Cheaper ways to get the header don't hold up: a shared `Blob` body is
   as fast as a bare string, but Bun derives its `content-type` lazily, so the header disappears
   once the body is read, which breaks `app.call()`. `clone()` of a template Response saves only ~25 ns.
2. **Dispatch overhead (~50–80 ns more than Elysia).** It is spread across many small pieces, each
   10–30 ns (context object, path extraction, the validated-params copy, hook and promise checks),
   with no single hotspot left in the profile. Elysia generates one specialized function per route
   with `new Function`. MiuJS cannot (Workers forbid it; see AGENTS.md), so it pays a few generic
   branches per request instead.

Unblocking item 1 is a product decision: either drop `content-type` from string Response objects
on Bun, as Elysia does, or keep the header and accept the gap.
