# MiuJS benchmarks

Requests per second (higher is better). Each framework serves the same three routes on `Bun.serve`;
load comes from 2 separate Bun processes running 64 concurrent `fetch` loops in total,
3s per route after a 1s warm-up. Client and server share the machine, so absolute numbers are
bounded by the load generator — compare columns, not against other published benchmarks.

| Route | miu | hono | elysia |
| --- | ---: | ---: | ---: |
| GET / (text) | 20,688 | 31,752 | 39,995 |
| GET /user/:id (JSON) | 19,188 | 31,383 | 41,418 |
| POST /json (validated echo) | 15,898 | 19,726 | 25,484 |

- Date: 2026-10-14
- Runtime: Bun 1.4.2
- CPU: Intel(R) Xeon(R) Processor @ 2.80GHz × 4
- Reproduce: `cd bench && bun install && bun run.ts --duration 3 --concurrency 64`
