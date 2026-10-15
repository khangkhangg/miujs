# @miujs/session

> Signed-cookie or server-side sessions for MiuJS, with flash messages and same-origin CSRF protection.

`session()` puts a `Session` on `ctx.session` for every request. By default all session data lives in an HMAC-SHA256 signed cookie; pass a `store` to keep data on the server (memory, SQL via `@miujs/db`, Cloudflare KV or Redis) and put only the signed id in the cookie. It also blocks cross-site unsafe requests that carry the session cookie. Use it on its own for anonymous state (carts, flash notices), and put it before `auth()` from `@miujs/auth`, which needs it.

## Install

```bash
bun add @miujs/session miujs
```

Bun runs the TypeScript source; Node and Deno get prebuilt JS with `.d.ts` types (npm packages are not published yet).

## Quick start

<!-- test -->
```ts
import { miu, route, t } from "miujs";
import { session } from "@miujs/session";

const setName = route.post("/name", {
  body: t.object({ name: t.string() }),
  handler: ({ session, body }) => {
    session.set("name", body.name);
    session.flash("notice", "Saved");
    return { ok: true };
  },
});

const getName = route.get("/name", {
  handler: ({ session }) => ({
    name: session.get<string>("name") ?? null,
    notice: session.get<string>("notice") ?? null, // flash: readable on the next request only
  }),
});

export default miu({ name: "demo", plugins: [session()], routes: [setName, getName] });
```

Set `SESSION_SECRET` (32+ random characters) in the environment, or pass `session({ secret })`. In dev without a secret, a random one is generated per process (sessions reset on restart) and a warning is logged once. Outside dev a missing secret is an error.

## The session API

`ctx.session` has:

| Method | What it does |
| --- | --- |
| `id` | Session id. Stable until `regenerate()` or `destroy()`. |
| `get<T>(key)` | Read a value (or a flash value set on the previous request). |
| `set(key, value)` | Write a JSON-serializable value. |
| `delete(key)` | Remove a key. |
| `flash(key, value)` | Store a value readable only during the next request. |
| `regenerate()` | New id, same data. Call on login and privilege changes (prevents session fixation). |
| `destroy()` | Clear all data and expire the cookie. |

A `Set-Cookie` header is only sent when the session changed. Responses that set the cookie also get `Cache-Control: private, no-store`. Other plugins can read the session with `getSession(ctx)`, which returns `undefined` when `session()` is not installed.

<!-- test -->
```ts
import { miu, route } from "miujs";
import { session } from "@miujs/session";

const login = route.post("/login", {
  handler: ({ session }) => {
    session.regenerate(); // new id after a privilege change
    session.set("userId", "u_1");
  },
});
const logout = route.post("/logout", { handler: ({ session }) => void session.destroy() });

export default miu({ plugins: [session({ secret: process.env.SESSION_SECRET })], routes: [login, logout] });
```

## Server-side stores

With a store, the cookie holds only the signed session id, so data size is not limited by the 4 KB cookie limit and `destroy()` deletes the record on the server.

| Store | Use |
| --- | --- |
| `memorySessionStore()` | In-process. Lost on restart, not shared between instances. Dev and tests. |
| `dbSessionStore(database, { table? })` | A `miu_sessions` table (created on first use) in any `@miujs/db` database: SQLite locally, D1 on Workers. |
| `kvSessionStore(bindingOrName)` | Cloudflare KV. Pass the binding, or its name to read it from `ctx.env` per request. Keys are prefixed `miu_session:`. |
| `redisSessionStore(client, { prefix? })` | Redis, expired by Redis (`SET ... PX`) and checked on read. Default prefix `miu:session:`. `bunRedis()` from `@miujs/cache` satisfies the client type. |

<!-- test -->
```ts
import { miu } from "miujs";
import { sqlite } from "@miujs/db";
import { dbSessionStore, memorySessionStore, session } from "@miujs/session";

const dev = miu({ plugins: [session({ store: memorySessionStore() })] });
const prod = miu({ plugins: [session({ store: dbSessionStore(sqlite("app.db")), maxAge: 24 * 3600 })] });

export { dev, prod };
```

Expired records are rejected on read by every store. Without a store (the default), logout cannot revoke a cookie that was copied elsewhere before it expired; use a server store if that matters.

## CSRF protection

With `csrf: true` (the default), a `POST`, `PUT`, `PATCH` or `DELETE` that carries the session cookie must prove it came from this site:

- If `Origin` is present, its host must equal the request host or be in `trustedOrigins`.
- Otherwise `Referer` must match the same way.
- With neither header, the request is rejected (403 `MIU_E_CSRF`).

Requests without the session cookie (for example API clients using `Authorization: Bearer`) are not checked. `GET` is never checked.

Route tags change this:

- `csrf-exempt`: skip the check (webhooks).
- `csrf-always`: check even without a cookie (sign-in forms, against login CSRF). A browser request is rejected when `Origin`/`Referer` is cross-site or `Sec-Fetch-Site: cross-site`; clients that send none of these headers (curl, servers) are allowed. `@miujs/auth` tags its login, register and logout routes this way.

<!-- test -->
```ts
import { miu, route } from "miujs";
import { session } from "@miujs/session";

const webhook = route.post("/hooks/stripe", { tags: ["csrf-exempt"], handler: () => "ok" });
const signIn = route.post("/sign-in", { tags: ["csrf-always"], handler: () => "ok" });

export default miu({
  plugins: [session({ trustedOrigins: ["https://admin.example.com"] })],
  routes: [webhook, signIn],
});
```

## Cookie and secret details

- Cookie value: without a store, `base64url(JSON).signature`; with a store, `id.signature`. Signature is HMAC-SHA256, base64url.
- Defaults: name `miu_session`, `Max-Age` 7 days, `Path=/`, `HttpOnly`, `SameSite=Lax`, `Secure` except on `http://localhost`, `127.0.0.1` and `[::1]`.
- Secrets shorter than 32 characters fail with `MIU_E_SESSION_SECRET_WEAK`.
- Rotation: pass an array. The first secret signs new cookies; all of them verify.
- Tampered, foreign-secret, malformed or expired cookies are ignored (the request gets a fresh session) and the bad cookie is expired.
- A cookie session larger than about 4 KB fails with `MIU_E_SESSION_TOO_LARGE` instead of being silently dropped by the browser.
- `inspect()` reports the store, cookie name, max age, CSRF setting and trusted origins, never the secret.

## Options

`session(options)`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `secret` | `string \| string[]` | `env.SESSION_SECRET` | HMAC secret, 32+ characters. An array rotates: first signs, all verify. |
| `store` | `SessionStore` | none (data in the signed cookie) | Server-side store. |
| `maxAge` | `number` | `604800` (7 days) | Lifetime in seconds. |
| `cookieName` | `string` | `"miu_session"` | Cookie name. |
| `secure` | `boolean` | `true`, except for `http://localhost` | `Secure` cookie attribute. |
| `sameSite` | `"Lax" \| "Strict" \| "None"` | `"Lax"` | `SameSite` cookie attribute. |
| `httpOnly` | `boolean` | `true` | `HttpOnly` cookie attribute. |
| `domain` | `string` | none | `Domain` cookie attribute. |
| `path` | `string` | `"/"` | `Path` cookie attribute. |
| `trustedOrigins` | `string[]` | `[]` | Extra origins allowed to send unsafe requests with the cookie. |
| `csrf` | `boolean` | `true` | Same-origin check on unsafe methods. |
| `onWarning` | `(message: string) => void` | request logger | Where dev-mode warnings go. |

Store options: `dbSessionStore(database, { table })` (default `"miu_sessions"`), `redisSessionStore(client, { prefix })` (default `"miu:session:"`).

## Errors

- [`MIU_E_SESSION_SECRET_MISSING`](../../docs/errors.md#miu_e_session_secret_missing): no secret outside dev. Set `SESSION_SECRET`.
- [`MIU_E_SESSION_SECRET_WEAK`](../../docs/errors.md#miu_e_session_secret_weak): a secret is shorter than 32 characters.
- [`MIU_E_CSRF`](../../docs/errors.md#miu_e_csrf): 403, cross-site unsafe request with the session cookie (or on a `csrf-always` route).
- [`MIU_E_SESSION_TOO_LARGE`](../../docs/errors.md#miu_e_session_too_large): cookie session over ~4 KB. Store less or use a server store.
- [`MIU_E_SESSION_KV_MISSING`](../../docs/errors.md#miu_e_session_kv_missing): `kvSessionStore("NAME")` but no such KV binding in `env`.
- [`MIU_E_SESSION_TABLE_INVALID`](../../docs/errors.md#miu_e_session_table_invalid): `dbSessionStore` table name is not letters, digits and underscores.
- [`MIU_E_SESSION_REDIS_CLIENT`](../../docs/errors.md#miu_e_session_redis_client): `redisSessionStore` got something without `get`/`set`/`del`.
- [`MIU_E_SESSION_REDIS`](../../docs/errors.md#miu_e_session_redis): a Redis command failed.

See [all error codes](../../docs/errors.md).

## Cloudflare Workers

- `SESSION_SECRET` is read from `env` per request; set it with `wrangler secret put SESSION_SECRET`.
- The default cookie store needs no bindings.
- `kvSessionStore("SESSIONS")` reads the KV namespace from `env` per request and declares `kv: ["SESSIONS"]` for `miu deploy cloudflare`. KV's minimum TTL is 60 seconds, so TTLs are raised to at least 60; expiry is also checked on read.
- `dbSessionStore(d1("DB"))` declares `d1: ["DB"]`.
- Passing a binding object instead of a name works too, but declares nothing.

## Links

- [Getting started guide](../../docs/guide.md)
- [Error codes](../../docs/errors.md)
- [AGENTS.md](../../AGENTS.md)
- [Source](./src)
- [Tests](./test)
- [@miujs/auth](../auth/README.md)
- [@miujs/db](../db/README.md)
- [@miujs/access](../access/README.md)
