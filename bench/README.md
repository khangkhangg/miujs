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
req/s fall from row to row for every framework. **Compare within a row, not across rows.**

| Scenario | MiuJS | Elysia 1.4.30 | Hono 4.13.13 | MiuJS vs best other |
| --- | ---: | ---: | ---: | ---: |
| `GET /` text | 968,000 | 1,250,000 | 789,000 | 77% |
| `GET /users/:id` params → JSON | 302,500 | 429,500 | 260,000 | 70% |
| `POST /json` body validation → JSON | 149,000 | 133,000 | 150,000 | 99% |

Summary: MiuJS is ahead of Hono on the text and params rows and level with it on the JSON body.
It matches Elysia when validating request bodies and trails Elysia by 20–30% on trivial routes.
The spec targets "within 10% of Elysia", so trivial routes are not there yet.

## Where the time goes (measured)

| Piece | Cost |
| --- | ---: |
| Router, dynamic `/users/:id` | ~40 ns |
| Params validation `t.object({ id: t.string() })` | ~45 ns |
| Request context creation | ~9 ns |
| `Response.json(...)` | ~250 ns |
| `new Request(...)` (paid by the caller) | ~165 ns |

Routing, validation and context setup are already small. The rest of the gap to Elysia is in the
dispatch path, and finding it needs a CPU profile.
