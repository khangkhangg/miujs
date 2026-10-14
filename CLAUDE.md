# MiuJS — notes for Claude

## Product principles (non-negotiable; weigh every change against these)
1. **Fast** — hot-path changes are benchmarked (`bun run bench:micro`, `bun run bench`); no regressions without a
   recorded reason. Target: Elysia-level throughput.
2. **Secure by default** — safe defaults (HttpOnly/SameSite cookies, CSRF-safe sessions, no stack traces or
   secrets in production responses, constant-time compares, input validated at the edge). Dev-only features
   must be impossible to enable in production by accident.
3. **Scalable** — every stateful battery has a single-node default (SQLite/memory) and a scale-out driver
   (Redis, Cloudflare D1/KV/Durable Objects); no in-process state that silently breaks with multiple instances.
4. **Reusable components** — build features from small composable pieces (stores, middleware, schemas, entry
   points); prefer extending an existing module over a parallel one.
5. **Easy app building, including backend management** — a user should get a working admin/back-office
   (CRUD, auth, uploads) for their data with minimal code, generated from schemas.
6. **Reference use case: virtual-tour apps** — creators upload panorama images, map hotspots that link scenes,
   and publish tours. Uploads, image storage (local/R2), scene/hotspot data and the viewer must be easy.
7. **Debuggable in the browser DevTools** — source maps, `Server-Timing`, readable errors in dev, a request
   inspector, and `--inspect` debugging must work; errors should be understandable from the Network/Console tabs.

## Engineering rules

- Runtime: Bun (tests: `bun test`, types: `bun run typecheck`). Source must also run on Node 22 with
  `--experimental-strip-types`, so only erasable TS syntax (no enums, parameter properties, namespaces);
  `erasableSyntaxOnly` enforces it.
- Core must stay Web-standard (`Request`/`Response`) so it runs on Cloudflare Workers. Runtime-specific code
  goes in `src/adapters/`.
- TDD: write the failing test in `test/` first, watch it fail, then implement.
- Every route is an MCP tool and an OpenAPI operation; new route meta fields must be reflected in
  `src/ai/mcp.ts` and `src/ai/openapi.ts`.
- Roadmap and feature checklist: `docs/ROADMAP.md` — tick items as they land.
- Entry points (package.json `exports`): `.` (portable core + batteries), `./sqlite`, `./node`, `./cloudflare`,
  `./realtime`, `./migrate`, `./client`. Only `./sqlite` and `./node` may import `bun:`/`node:` modules;
  `test/exports.test.ts` enforces this. Add new public APIs to the right entry and to that test.
- Performance: the request hot path is in `src/core/app.ts` (`fetch`) and `src/core/context.ts`. Check changes with
  `bun run bench:micro` and record honest numbers in `bench/results.md`.
