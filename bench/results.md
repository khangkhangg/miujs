# Benchmark results

Machine: 4-core Xeon 2.8 GHz, Bun 1.4.2, quiet machine. Load generator and servers share the machine, so treat
differences under ~10% as noise. Reproduce with `bun run.ts` (network) and `bun micro.ts` (in-process).
Miu is served with `Bun.serve(app.serveOptions())` (Bun native routes, what `app.listen()` uses); Elysia with
its own `.listen()`; Hono with `Bun.serve({ fetch })`.

## Network (`bun run.ts --duration 5 --concurrency 64`), requests/second, three consecutive runs (v0.4)

| Route | miu | hono | elysia |
| --- | ---: | ---: | ---: |
| GET / (text) — run 1 | 47,096 | 47,651 | 49,837 |
| GET / (text) — run 2 | 45,372 | 45,966 | 51,938 |
| GET / (text) — run 3 | 41,348 | 43,586 | 48,099 |
| GET /user/:id (JSON) — run 1 | 41,826 | 38,760 | 47,252 |
| GET /user/:id (JSON) — run 2 | 41,834 | 35,961 | 47,904 |
| GET /user/:id (JSON) — run 3 | 40,823 | 33,486 | 45,260 |
| POST /json (validated) — run 1 | 30,969 | 23,154 | 27,874 |
| POST /json (validated) — run 2 | 28,806 | 25,968 | 29,141 |
| POST /json (validated) — run 3 | 26,962 | 23,198 | 26,614 |

For reference, a bare `Bun.serve` returning a constant response reaches ~48–51k req/s on this machine.

## In-process framework overhead (`bun micro.ts --iterations 100000 --rounds 5`, median), requests/second

Calls each framework's fetch handler directly without a server (Miu's server-only fast paths are not exercised).

| Case | miu | hono | elysia |
| --- | ---: | ---: | ---: |
| GET / (text) | 365,736 | 568,378 | 760,811 |
| GET /user/:id (JSON) | 247,312 | 237,524 | 363,146 |
| POST /json (validated) | 120,190 | 138,358 | 116,103 |

## Summary

- **Over the network:** Miu is level with Hono on plain text, ~15% ahead of Hono on JSON params and validated
  POSTs, ~90% of Elysia on simple GETs, and level with or ahead of Elysia on validated POSTs.
- History: v0.2 was 55–65% of Hono; v0.3 hot-path work reached Hono parity; v0.4 added Bun native routes.
- Remaining gap to Elysia on GETs: per-request Context allocation and param decoding; Elysia compiles each
  route into a specialized handler.
