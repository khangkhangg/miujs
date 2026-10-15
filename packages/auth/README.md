# @miujs/auth

> Email and password accounts, API tokens, roles, rate-limited sign-in and password hashing for MiuJS, on top of @miujs/session.

`auth()` adds register, login, logout, `me` and API token routes under `/auth`, and sets `ctx.user` from the session cookie or an `Authorization: Bearer` token. The core then enforces each route's `auth` setting (`"required"`, `"optional"`, `{ role }`). Users live in a `UserStore`: `memoryUserStore()` for dev and tests, `dbUserStore(db)` (SQLite or D1 via `@miujs/db`) for real apps. Use it whenever an app has user accounts; it needs `session()` earlier in `plugins`.

## Install

```bash
bun add @miujs/auth @miujs/session @miujs/db miujs
```

Bun runs the TypeScript source; Node and Deno get prebuilt JS with `.d.ts` types (npm packages are not published yet).

## Quick start

<!-- test -->
```ts
import { miu, route } from "miujs";
import { session } from "@miujs/session";
import { auth, memoryUserStore } from "@miujs/auth";

const dashboard = route.get("/dashboard", {
  auth: "required",
  handler: ({ user }) => ({ hello: user.email ?? user.id }),
});

const admin = route.get("/admin", { auth: { role: "admin" }, handler: () => "admin ok" });

export default miu({
  name: "accounts",
  plugins: [session(), auth({ users: memoryUserStore() })],
  routes: [dashboard, admin],
});
```

Then, from a browser on the same origin or from curl:

```bash
curl -X POST localhost:3000/auth/register -H 'content-type: application/json' \
  -d '{"email":"ann@example.com","password":"correct horse battery","name":"Ann"}'
```

## Routes

All paths are under `basePath` (default `/auth`). Sign-in routes are not exposed as MCP tools.

| Route | What it does |
| --- | --- |
| `POST /auth/register` | `{ email, password, name? }`. Creates a user and signs in (201). 409 `MIU_E_AUTH_EMAIL_TAKEN` if the email exists. Off with `register: false`. |
| `POST /auth/login` | `{ email, password }`. Signs in and regenerates the session id. |
| `POST /auth/logout` | Destroys the session. |
| `GET /auth/me` | The signed-in user: `{ user: { id, email, name, roles } }`. |
| `POST /auth/tokens` | `{ name, expiresInDays? }`. Creates an API token for the signed-in user; the token is returned once (201). |
| `DELETE /auth/tokens/:id` | Revokes one of your tokens. |

With a mailer (`auth({ mailer })` or `mail()` from `@miujs/mail` in `plugins`), these are added:

| Route | What it does |
| --- | --- |
| `POST /auth/password/forgot` | `{ email }`. Emails a reset link. Always 202, whether or not the account exists. |
| `POST /auth/password/reset` | `{ token, password }`. Sets the password, signs out other sessions, deletes the user's API tokens, signs in. Links expire after 1 hour and work once. |
| `POST /auth/password/change` | `{ currentPassword, newPassword }`, signed in. Other sessions are signed out; API tokens are kept. |
| `POST /auth/verify-email/request` | Emails a new confirmation link (only when `emailVerification` is not `"off"`). |
| `POST /auth/verify-email` | `{ token }`. Confirms the address. Links expire after 24 hours. |

`emailVerification: "optional"` sends a link on register and sets `ctx.user.emailVerified`. `"required"` also blocks sign-in until the address is confirmed, and register always answers 202 `{ status: "check-your-email" }` so it cannot be used to test which emails have accounts.

## Users in a database

`dbUserStore` creates its tables on first use (`authMigrations`); pass `{ migrate: false }` if you run migrations yourself.

<!-- test -->
```ts
import { miu } from "miujs";
import { sqlite } from "@miujs/db";
import { session } from "@miujs/session";
import { auth, dbUserStore } from "@miujs/auth";

export default miu({
  plugins: [
    session(),
    auth({ users: dbUserStore(sqlite("app.db")), defaultRoles: ["member"], minPasswordLength: 12 }),
  ],
});
```

On Workers use `dbUserStore(d1("DB"))` with `d1` from `@miujs/db`.

## API tokens

`POST /auth/tokens` returns a token like `miu_<43 base64url chars>` once. Only its SHA-256 hash is stored. Send it as `Authorization: Bearer <token>`; an unknown, expired or malformed token gives 401 `MIU_E_AUTH_TOKEN_INVALID`. Requests with a bearer token and no session cookie are not subject to the session CSRF check. Change the prefix with `tokenPrefix` so leaked tokens are easy to scan for.

## Passwords

Passwords are hashed with argon2id when `Bun.password` exists, otherwise PBKDF2-SHA256 with 600,000 iterations in Django's `pbkdf2_sha256$...` format. `verifyPassword` also accepts Django PBKDF2 hashes and, on Bun, bcrypt (`$2a$`, `$2b$`, `$2y$`) and argon2 hashes. On login, a hash that is not in the preferred format is replaced (`needsRehash`). Passwords must be `minPasswordLength` (default 8) to 1024 characters.

<!-- test -->
```ts
import { hashPassword, needsRehash, verifyPassword } from "@miujs/auth";

const opts = { algorithm: "pbkdf2" as const };
const hash = await hashPassword("correct horse battery", opts);
const ok = await verifyPassword("correct horse battery", hash, opts); // true
const upgrade = needsRehash(hash, opts); // false
console.log(ok, upgrade);
```

## Security defaults

- **Sessions:** login, register and password reset call `session.regenerate()` (no session fixation). A password reset or change bumps the user's session version, which signs out older sessions.
- **Login CSRF:** register, login, logout and the email/password routes are tagged `csrf-always`, so `session()` rejects cross-site browser requests (403 `MIU_E_CSRF`) even without a cookie. Clients that send no `Origin` still work.
- **Brute force:** on by default. Login: 10 per IP+account, 50 per account, 100 per IP per 15 minutes. Register: 10 per IP per hour. Password reset and verify-email requests: 5 per account and 20 per IP per hour. Over the limit gives 429 `MIU_E_RATE_LIMITED` with `Retry-After`. `rateLimit: false` turns it off.
- **Client IP:** `ctx.ip` (Cloudflare's address on Workers, the socket address on Bun). Behind your own proxy, prefer core's `miu({ trustProxy })`; `rateLimit.trustProxyHeader` still works but is deprecated.
- **Account enumeration:** login gives the same error (401 `MIU_E_AUTH_INVALID`) and does the same hashing work for unknown emails and wrong passwords. Register returns 409 for a taken email unless `emailVerification: "required"`.
- **Emailed links:** built from `appUrl` or `env.APP_URL`, never from the Host header outside dev. One-time tokens are stored as SHA-256 hashes.
- **Turnstile:** `turnstile: {}` checks a Cloudflare Turnstile token (`cf-turnstile-response` body field or header) on register and login, using `env.TURNSTILE_SECRET_KEY` by default.

<!-- test -->
```ts
import { miu } from "miujs";
import { session } from "@miujs/session";
import { auth, memoryUserStore } from "@miujs/auth";

export default miu({
  plugins: [
    session(),
    auth({
      users: memoryUserStore(),
      rateLimit: { login: { perIpAccount: 5, windowSeconds: 600 } },
      turnstile: {},
    }),
  ],
});
```

## OAuth and passkeys

These are exported and tested but still being extended; check [the source](./src) before relying on details.

- `oauth: { google, github, apple, discord, oidc: [...] }` adds `GET /auth/oauth/:provider` and its `/callback` (authorization code with PKCE, state and nonce). Register `<appUrl>/auth/oauth/<id>/callback` at each provider. A provider identity is only linked to an existing account when both emails are verified.
- `passkeys: { rpId, rpName, origins }` adds WebAuthn registration and sign-in under `/auth/passkeys`.

Both need a store with the extra methods (`memoryUserStore()` and `dbUserStore()` have them).

## Options

`auth(options)`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `users` | `UserStore` | `memoryUserStore()` | Where users and tokens live. Use `dbUserStore(db)` in real apps. |
| `basePath` | `string` | `"/auth"` | Prefix for all auth routes. |
| `password` | `PasswordOptions` | `{}` | `{ algorithm?: "argon2id" \| "pbkdf2", iterations?, workersCpuMs? }`. Default argon2id on Bun, else PBKDF2 with 600,000 iterations. `workersCpuMs` is your Workers CPU limit per request (default 10, the Free plan) or `false`; see [Cloudflare Workers](#cloudflare-workers). |
| `defaultRoles` | `string[]` | `[]` | Roles given to newly registered users. |
| `minPasswordLength` | `number` | `8` | Minimum password length (maximum is 1024). |
| `register` | `boolean` | `true` | Serve `POST /register`. |
| `turnstile` | `TurnstileOptions` | off | `{ secretKey?, fetch? }`. Secret defaults to `env.TURNSTILE_SECRET_KEY`. |
| `tokenPrefix` | `string` | `"miu_"` | Prefix for API tokens. |
| `rateLimit` | `RateLimitOptions \| false` | on, see above | `{ limiter?, login?, register?, passwordReset?, verifyEmail?, trustProxyHeader? }`. |
| `mailer` | `AuthMailer` | `ctx.mail` from `mail()` | Sends verify and reset emails. Enables the password routes. |
| `appUrl` | `string` | `env.APP_URL` (request origin in dev only) | Public URL for emailed links. Required in production when emails are on. |
| `emailVerification` | `"off" \| "optional" \| "required"` | `"off"` | Email confirmation mode. |
| `emails` | `Partial<AuthEmails>` | `defaultAuthEmails` | Replace the verify, reset and already-registered email texts. |
| `pages` | `{ verifyEmail?, resetPassword?, forgotPassword? }` | `/verify-email`, `/reset-password`, `/forgot-password` | App pages that emailed links open. |
| `oauth` | `OAuthOptions` | off | OAuth / OpenID Connect providers. |
| `passkeys` | `PasskeyOptions` | off | Passkey (WebAuthn) sign-in. |

`rateLimit.limiter` is `memoryRateLimiter()` by default, or `cloudflareRateLimiter("BINDING")`.

## In @miujs/admin

`auth()` has a management section (`manage()`), shown by `@miujs/admin`:

- **Status**: user count, sign-ups, sign-ins and failed sign-ins since the instance started, sign-in methods (names only), password hashing parameters, email verification mode, login rate limit.
- **Users list** (paged, search by email): disable / enable (a disabled user is signed out, cannot sign in, and their API tokens stop working until enabled), sign out everywhere, revoke API tokens, send a password reset email (with a mailer), unlink an OAuth provider (never the last way to sign in).
- **Settings** (apply at once, in this instance): allow sign-ups (password and OAuth; existing users always sign in), minimum password length, login lockout thresholds.

Nothing there shows password hashes, tokens, reset links or provider secrets. Custom `UserStore`s get the list and row actions by implementing `countUsers`, `listUsers`, `setUserDisabled` and `revokeSessions` (the built-in stores have them; `dbUserStore` adds `users.disabled_at` in migration `miu_auth_004_disabled`).

## Errors

- [`MIU_E_AUTH_INVALID`](../../docs/errors.md#miu_e_auth_invalid): 401, wrong email or password.
- [`MIU_E_AUTH_TOKEN_INVALID`](../../docs/errors.md#miu_e_auth_token_invalid): 401, bad or expired API token.
- [`MIU_E_AUTH_EMAIL_TAKEN`](../../docs/errors.md#miu_e_auth_email_taken): 409 on register.
- [`MIU_E_AUTH_PASSWORD_WEAK`](../../docs/errors.md#miu_e_auth_password_weak): 400, password too short or too long.
- [`MIU_E_AUTH_PASSWORD_INCORRECT`](../../docs/errors.md#miu_e_auth_password_incorrect): 403, wrong current password on change.
- [`MIU_E_AUTH_EMAIL_UNVERIFIED`](../../docs/errors.md#miu_e_auth_email_unverified): 403, sign-in before confirming the email (`"required"` mode).
- [`MIU_E_AUTH_VERIFY_INVALID`](../../docs/errors.md#miu_e_auth_verify_invalid) / [`MIU_E_AUTH_RESET_INVALID`](../../docs/errors.md#miu_e_auth_reset_invalid): 400, link invalid, used or expired.
- [`MIU_E_AUTH_SESSION_REQUIRED`](../../docs/errors.md#miu_e_auth_session_required): `session()` missing or after `auth()` in `plugins`.
- [`MIU_E_AUTH_MAILER_MISSING`](../../docs/errors.md#miu_e_auth_mailer_missing) / [`MIU_E_AUTH_APP_URL_MISSING`](../../docs/errors.md#miu_e_auth_app_url_missing): email features on without a mailer or public URL.
- [`MIU_E_AUTH_TURNSTILE_FAILED`](../../docs/errors.md#miu_e_auth_turnstile_failed): 403, bot check failed.
- [`MIU_E_AUTH_RATELIMIT_BINDING`](../../docs/errors.md#miu_e_auth_ratelimit_binding): `cloudflareRateLimiter` binding not configured.
- [`MIU_E_AUTH_HASH_UNSUPPORTED`](../../docs/errors.md#miu_e_auth_hash_unsupported): bcrypt or argon2 hash outside Bun.
- [`MIU_E_AUTH_STORE_UNSUPPORTED`](../../docs/errors.md#miu_e_auth_store_unsupported): the user store lacks methods a feature needs.
- [`MIU_E_AUTH_ACCOUNT_DISABLED`](../../docs/errors.md#miu_e_auth_account_disabled): 403, an operator disabled this account (only after the password matched).
- [`MIU_E_AUTH_SIGNUPS_CLOSED`](../../docs/errors.md#miu_e_auth_signups_closed) / [`MIU_E_AUTH_OAUTH_SIGNUPS_CLOSED`](../../docs/errors.md#miu_e_auth_oauth_signups_closed): 403, an operator closed sign-ups; existing users still sign in.

See [all error codes](../../docs/errors.md).

## Cloudflare Workers

- `dbUserStore(d1("DB"))` declares a `d1` binding for `miu deploy cloudflare`.
- The default memory rate limiter counts per isolate, so limits are approximate on Workers. Use `rateLimit: { limiter: cloudflareRateLimiter("LOGIN_LIMIT") }`: `auth().cloudflare()` then declares a `[[ratelimits]]` binding with the login per-IP+account limit and a 60-second period. The binding's own limit applies to every rule. A missing binding fails with `MIU_E_AUTH_RATELIMIT_BINDING` rather than leaving login unprotected.
- `APP_URL` and `TURNSTILE_SECRET_KEY` are read from `env` per request, so the missing-`APP_URL` check happens when the first link is built.
- Passwords use PBKDF2 via Web Crypto on Workers (no `Bun.password`), so bcrypt and argon2 legacy hashes cannot be verified there.

### PBKDF2 and the Workers CPU limit

One PBKDF2-SHA256 hash at the default 600,000 iterations costs about 250 ms of CPU on workerd. Sign-up, sign-in (which may also rehash) and password changes each hash at least once. The Workers Free plan allows 10 ms of CPU per request; Paid plans default to 30,000 ms and let you set the limit with `[limits] cpu_ms` in `wrangler.toml`. auth() does not lower the iteration count for you. Instead:

- **Startup warning.** On Workers (and under `miu deploy cloudflare`), auth() logs one warning when a hash is estimated to cost more than `password.workersCpuMs` (default 10). The warning lists the options below. Set `workersCpuMs` to your plan's limit once it is high enough, or to `false` to turn the check off.
- **`miu deploy cloudflare`** writes `[limits] cpu_ms` when `auth().cloudflare()` asks for it: four hashes' worth (a verify plus a rehash, doubled for headroom), 1,100 ms at 600,000 iterations, or `workersCpuMs` if that is higher. The Free plan cannot set this. On Paid it replaces the 30,000 ms default, so raise it if other routes need more.

Pick one:

1. **Workers Paid with a CPU limit** (recommended). Keep 600,000 iterations and deploy with the generated `[limits] cpu_ms`. Then pass `auth({ password: { workersCpuMs: 1100 } })` so the warning goes away.
2. **Fewer iterations.** Pass `auth({ password: { iterations } })`. About 23,000 iterations fit in 10 ms. That makes a leaked hash about 25 times cheaper to guess offline than OWASP's 600,000. Existing hashes keep working, and `needsRehash` only upgrades a hash, never downgrades it.
3. **No passwords on Workers.** Sign users in with passkeys or OAuth, or delegate sign-in to an external identity provider.

## Links

- [Getting started guide](../../docs/guide.md)
- [Error codes](../../docs/errors.md)
- [AGENTS.md](../../AGENTS.md)
- [Source](./src)
- [Tests](./test)
- [@miujs/session](../session/README.md)
- [@miujs/db](../db/README.md)
- [@miujs/access](../access/README.md)
- [@miujs/audit](../audit/README.md)
