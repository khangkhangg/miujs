# @miujs/migrate

> Move a Laravel, Django or FastAPI app to MiuJS one route at a time.

MiuJS sits in front of the old app. Routes you have ported are served by MiuJS; everything else is
proxied to the old app. Users stay signed in on both, and recorded traffic becomes contract tests
that prove a ported route answers like the original.

## Install

```bash
bun add @miujs/migrate miujs @miujs/db
```

## Quick start

```ts
import { miu } from "miujs";
import { auth } from "@miujs/auth";
import { bridgeAuth, captureMiddleware, jsonlFileSink, laravelDatabaseStore, laravelSession, migrateProxy } from "@miujs/migrate";

export default miu({
  routes, // what is ported so far
  plugins: [
    captureMiddleware({ sink: jsonlFileSink("contracts.jsonl"), sample: 0.1 }), // record traffic (redacted)
    migrateProxy({ upstream: "http://laravel:8000" }), // everything else goes to the old app
    auth(),
    bridgeAuth({ from: laravelSession({ appKey: process.env.LARAVEL_APP_KEY!, store: laravelDatabaseStore(legacyDb) }), findUser }),
  ],
});
```

Order matters: capture first, `migrateProxy` before anything that reads the body, `bridgeAuth`
after your own `auth()`.

## What you get

| Piece | What |
| --- | --- |
| `migrateProxy({ upstream })` | Proxies every request no MiuJS route serves (and routes tagged `not-ported`) |
| `laravelSession`, `djangoSession` | Read the old app's session cookie and store, so logins are shared |
| `bridgeAuth({ from, findUser })` | Sets `ctx.user` from the legacy session when `auth()` did not |
| `captureMiddleware({ sink })` | Records requests and responses as contract cases, with secrets redacted |
| `verifyContracts(...)` | Replays recorded cases against the new app and reports differences |
| `fromOpenApi(spec)` | Route stubs and `t` schemas from the old app's OpenAPI document (FastAPI, ...) |

## Porting guides

Step-by-step guides for coding agents and humans:

- [Laravel](PORTING-laravel.md)
- [Django](PORTING-django.md)
- [FastAPI](PORTING-fastapi.md)
