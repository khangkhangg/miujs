# MiuJS — notes for Claude

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
