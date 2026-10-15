# @miujs/cli

> The `miu` command line: scaffold projects and files, run route tests, inspect apps, check for mistakes, manage SQLite/D1 migrations and deploy to Cloudflare Workers.

`@miujs/cli` installs the `miu` binary. Most commands load your app entry (a file that does `export default miu({...})`), call `await app.ready()` and work from `app.inspect()`, `app.openapi()` and `app.tests`. Use it in development and CI; nothing from it runs inside your deployed app.

## Install

```bash
bun add -d @miujs/cli
bun add miujs
```

Bun runs the TypeScript source; Node and Deno get prebuilt JS with `.d.ts` types (npm packages are not published yet). The `miu` binary itself runs on Bun (`#!/usr/bin/env bun`).

## Quick start

An app entry that `miu dev`, `miu test` and `miu inspect` can load:

<!-- test -->
```ts
import { miu, route, t, type CallFn } from "miujs";

export const health = route.get("/health", {
  summary: "Check that the app is up",
  response: t.object({ ok: t.boolean() }),
  handler: () => ({ ok: true }),
});

// `miu test` runs these; `call` is app.call.
export const tests = {
  "health returns ok": async (call: CallFn) => {
    const res = await call(health);
    res.expectStatus(200);
  },
};

// Passing the module object registers its routes and collects its `tests`.
export default miu({ name: "my-app", routes: [{ health, tests }], mcp: true });
```

In a real project the route lives in `routes/health.ts` and `app.ts` does `import * as health from "./routes/health.ts"` then `routes: [health]`. `miu new` creates that layout:

```bash
miu new my-app          # app.ts, routes/health.ts, AGENTS.md, package.json, tsconfig.json
cd my-app && bun install
miu dev                 # bun --hot app.ts
miu test                # runs the `tests` exported by route files
miu inspect --json      # routes, schemas, plugins, MCP tools, Cloudflare bindings
```

`miu` finds the entry in this order: `app.ts`, `src/app.ts`, `index.ts`, `src/index.ts`, `app.tsx`, `src/app.tsx`. Pass a path (`miu test api/app.ts`) or `--entry` to override.

## Commands

```bash
miu dev [entry]                    # bun --hot <entry>, with MIU_ENV=development
miu test [entry]                   # run route tests; exit 1 if any fail
miu inspect [entry] [--json]       # readable route list, or the full app.inspect() JSON
miu openapi [entry] [--out f]      # print or write the OpenAPI 3.1 spec
miu check [entry]                  # leaked secrets (error) and unauthenticated mutations (warning)
miu add route|job|room|plugin <name>   # scaffold routes/, jobs/, rooms/ or plugins/<name>.ts
miu new <dir>                      # new project in an empty folder
miu deploy cloudflare [--dry-run] [--force] [--out wrangler.toml] [--entry app.ts] [--compatibility-date YYYY-MM-DD]
miu db pull | migrate ...          # see below
miu loadtest <ws-url> --action '{"type":"inc","data":{}}' [--players 10] [--duration 10s] [--rate 5] [--json]
miu help                           # also: miu <command> --help
```

- `miu check` scans `.ts/.js/.json/.toml/.yaml/.env` files for API keys and private keys (`MIU_W_SECRET_IN_CODE`, exit 1) and warns about POST/PUT/PATCH/DELETE routes without `auth` (`MIU_W_UNAUTHENTICATED_MUTATION`, exit 0).
- `miu add route users/get-profile` writes `routes/users/get-profile.ts` with a handler that throws `MIU_E_NOT_IMPLEMENTED` and a failing test. It refuses to overwrite files.
- `miu loadtest` drives N simulated `@miujs/realtime` room clients and prints p50/p95/p99 latency from action to the next state patch.

`miu help` also lists `miu logs`, more `deploy` targets, `new --template` choices and a type check in `miu check`. In the current source those are not wired up yet: `logs` is rejected as an unknown command, `deploy` accepts only `cloudflare`, and `--template` and `--no-types` are accepted but have no effect.

## Database migrations

```bash
miu db pull --db app.sqlite --out schema.ts         # introspect into a Drizzle schema.ts
miu db pull --d1 my-db --json                       # describe a remote D1 database
miu db migrate --db app.sqlite                      # apply migrations/NNNN_name.sql not yet run
miu db migrate --d1 my-db --dir migrations          # same, through wrangler d1 execute --remote
miu db migrate --generate add_posts --schema db/schema.ts
```

Applied migrations are recorded in `_miu_migrations` (the same table `db({ migrations })` uses at runtime). Wrangler's `d1 migrations apply` keeps its own `d1_migrations` table, so pick one tool per database. `--generate` diffs your Drizzle tables against the database (or the replayed migrations) and writes the next file; destructive changes are printed, never written. Without `--db`, the only `*.sqlite`/`*.db` file in the folder is used.

## Programmatic use

<!-- test -->
```ts
import { runCli } from "@miujs/cli";

const lines: string[] = [];
const code = await runCli(["inspect", "--json"], {
  cwd: process.cwd(),
  out: (line) => lines.push(line),
  err: (line) => console.error(line),
  // run: a custom Runner for wrangler/bunx calls (tests inject one so nothing spawns)
});
console.log(code, lines.join("\n"));
```

`runCli(args, io)` returns the exit code. Also exported: `parseArgs`, `CliError`, `defaultRunner`, `wranglerToml`, `wranglerD1`, `inlineParams`.

## Options

Flags per command (anything else is `MIU_E_CLI_UNKNOWN_FLAG`). Value flags accept `--flag value` or `--flag=value`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `--entry` | path | first of `app.ts`, `src/app.ts`, `index.ts`, `src/index.ts`, `app.tsx`, `src/app.tsx` | App entry (dev, test, inspect, openapi, check, deploy). |
| `--json` | bool | `false` | Machine-readable output (inspect, db pull, loadtest). |
| `--out` | path | stdout (openapi), `wrangler.toml` (deploy), `schema.ts` (db pull) | Output file. |
| `--dry-run` | bool | `false` | deploy: write and print `wrangler.toml`, run nothing. |
| `--force` | bool | `false` | deploy: overwrite an existing `wrangler.toml`. |
| `--compatibility-date` | `YYYY-MM-DD` | today, capped at what the `workerd` in `node_modules` supports | deploy cloudflare: `compatibility_date`. An older local wrangler refuses dates newer than its workerd. |
| `--db` | path | the only `*.sqlite`/`*.db` file in cwd | db: local SQLite file. |
| `--d1` | string | none | db: remote D1 database name (`bunx wrangler d1 execute --remote --json`). |
| `--dir` | path | `migrations` | db migrate: folder of `NNNN_name.sql` files. |
| `--generate` | string | none | db migrate: write the next migration with this name. |
| `--schema` | path | none | db migrate `--generate`: module exporting Drizzle tables. |
| `--players` | integer | `10` | loadtest: simulated clients. |
| `--duration` | duration | `10s` | loadtest: `10s`, `500ms`, `2m`. |
| `--rate` | integer | `5` | loadtest: actions per second per client. |
| `--action` | JSON | required | loadtest: room message (or array of them) each client sends. |

## Errors

The CLI prints `error <CODE>: <message>` and a `fix:` line, then exits 1.

- `MIU_E_CLI_UNKNOWN_COMMAND`, `MIU_E_CLI_UNKNOWN_FLAG`, `MIU_E_CLI_FLAG_VALUE`: bad command line.
- `MIU_E_CLI_NO_APP`: no entry file found ([docs](../../docs/errors.md#miu_e_cli_no_app)).
- `MIU_E_CLI_NO_DEFAULT_EXPORT`: the entry does not `export default miu(...)`.
- `MIU_E_CLI_EXISTS`: a file or folder would be overwritten.
- `MIU_E_CLI_ADD_USAGE`, `MIU_E_CLI_NEW_USAGE`, `MIU_E_CLI_LOADTEST_USAGE`, `MIU_E_CLI_DB_USAGE`: missing arguments.
- `MIU_E_CLI_DEPLOY_TARGET`: a deploy target other than `cloudflare`.
- `MIU_E_CLI_DB_NOT_FOUND`, `MIU_E_CLI_DB_SOURCE`: the database file is missing or ambiguous.
- `MIU_E_CLI_WRANGLER`: `wrangler d1 execute` failed or printed non-JSON.
- `MIU_E_CLI_SCHEMA_NOT_FOUND`, `MIU_E_CLI_SCHEMA_EMPTY`, `MIU_E_CLI_DRIZZLE_MISSING`: problems with `--schema`.
- Any `MIU_E_*` error the app throws while loading (for example a route config error) is printed the same way.

See [all error codes](../../docs/errors.md).

## Cloudflare Workers

`miu deploy cloudflare` sets `MIU_TARGET=cloudflare`, loads the app so plugins choose their Workers adapters, and writes `wrangler.toml` from `app.inspect().cloudflare`: KV namespaces, D1 databases, R2 buckets, queue producers and consumers, Durable Object bindings with a `new_sqlite_classes` migration, cron triggers, `[assets]`, `[ai]`, `[[vectorize]]`, `[[workflows]]` and `[[ratelimits]]`. It then runs `bunx wrangler deploy --config wrangler.toml` (needs `wrangler login`). Re-run it after adding plugins. Secrets are not written; set them with `wrangler secret put`. `miu db ... --d1` talks to remote D1 through wrangler. The CLI itself never runs on Workers.

## Links

- [Getting started guide](../../docs/guide.md)
- [Error codes](../../docs/errors.md)
- [AGENTS.md](../../AGENTS.md)
- [Source](./src)
- [Tests](./test)
- [miujs](../miujs/README.md), [@miujs/db](../db/README.md), [@miujs/realtime](../realtime/README.md), [@miujs/queue](../queue/README.md)
