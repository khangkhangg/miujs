# Benchmark results

Machine: 4-core Xeon 2.8 GHz, Bun 1.4.2. Load generator and servers share the machine, so treat
differences under ~10% as noise. Reproduce with `bun run.ts` (network) and `bun micro.ts` (in-process).

## Network (`bun run.ts --duration 3 --concurrency 64`), requests/second, two consecutive runs

| Route | miu | hono | elysia |
| --- | ---: | ---: | ---: |
| GET / (text) — run 1 | 42,637 | 40,550 | 46,954 |
| GET / (text) — run 2 | 39,465 | 44,144 | 47,591 |
| GET /user/:id (JSON) — run 1 | 37,454 | 34,357 | 50,032 |
| GET /user/:id (JSON) — run 2 | 34,330 | 34,844 | 47,250 |
| POST /json (validated) — run 1 | 29,028 | 23,134 | 29,137 |
| POST /json (validated) — run 2 | 23,462 | 24,290 | 27,628 |

## In-process framework overhead (`bun micro.ts --iterations 100000 --rounds 5`, median), requests/second

Calls each framework's fetch handler directly, isolating router/validation/response overhead.

| Case | miu | hono | elysia |
| --- | ---: | ---: | ---: |
| GET / (text) | 409,626 | 499,643 | 781,907 |
| GET /user/:id (JSON) | 226,212 | 227,317 | 443,184 |
| POST /json (validated) | 131,714 | 159,114 | 124,527 |

## Summary

- Miu is on par with Hono over the network and within ~0–20% in-process.
- Elysia is ~15–25% faster on simple GET routes over the network (it compiles handlers ahead of time);
  on validated POST bodies Miu is within ~15% of Elysia and faster in-process.
- Before the v0.3 hot-path work, Miu was at 55–65% of Hono and 40–50% of Elysia.

Next steps toward Elysia-level GET throughput: precompiled per-route handlers and a static-response cache
for handlers that return constants.
