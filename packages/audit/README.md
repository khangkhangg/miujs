# @miujs/audit

> A tamper-evident audit log for MiuJS: field-level diffs, secret redaction, an HMAC-SHA256 hash chain with key rotation, external anchoring, verification and retention.

`audit()` adds `ctx.audit.log()` and `ctx.audit.query()` to every request and serves `GET /audit`. Each entry records the actor, org, IP, user agent and request id of the request, stores only the fields that changed between `before` and `after`, and redacts secrets. Rows form a hash chain (HMAC-SHA256 when a key is set) that `verifyChain()` re-checks, so edited, deleted or reordered rows are detected. Use it for compliance trails (healthcare, finance, admin actions) and to record sign-in events from `@miujs/auth`.

## Install

```bash
bun add @miujs/audit @miujs/db miujs
```

Bun runs the TypeScript source; Node and Deno get prebuilt JS with `.d.ts` types (npm packages are not published yet).

## Quick start

<!-- test -->
```ts
import { miu, route, t } from "miujs";
import { sqlite } from "@miujs/db";
import { audit, dbAuditStore } from "@miujs/audit";

const updateContact = route.post("/contacts/:id", {
  params: t.object({ id: t.string() }),
  body: t.object({ name: t.string() }),
  handler: async (ctx) => {
    const before = { name: "Ann", email: "ann@example.com" };
    const after = { ...before, name: ctx.body.name };
    // Stores { name: { before, after } } plus actor, org, ip, user agent, request id and time.
    const rec = await ctx.audit.log({ action: "update", resource: "contacts", resourceId: ctx.params.id, before, after });
    return { seq: rec.seq };
  },
});

export default miu({
  plugins: [audit({ store: dbAuditStore(sqlite("app.db")) })],
  routes: [updateContact],
});
```

Set `AUDIT_HMAC_KEY` (32+ random characters) in production. Without a key the chain is plain SHA-256, which anyone with database write access can recompute; the plugin logs a warning outside dev.

## Logging and querying

`ctx.audit.log(entry)` takes:

| Field | Description |
| --- | --- |
| `action` | What happened, e.g. `"update"`, `"export"`, `"view"`. Required. |
| `resource` | What it happened to, e.g. `"contacts"`. Required. |
| `resourceId` | Optional string or number. |
| `before` / `after` | State before and after. Only changed fields are stored, as `{ field: { before?, after? } }`. |
| `metadata` | Optional object, redacted like the diff. |

`ctx.audit.query(q)` and `GET /audit` filter by `resource`, `resourceId`, `actor`, `org`, `since` (inclusive) and `until` (exclusive), newest first, with `limit` (1 to 1000, default 50) and a `cursor` from the previous page's `nextCursor`. `ctx.audit.query` does no permission check.

`GET /audit` requires sign-in plus the `permission` option (default `audit:read`) when `ctx.can` exists (from `@miujs/access`), otherwise the `admin` role. When an org is active, results are limited to that org.

## Diffs and redaction

Values under secret-looking keys are replaced by `[REDACTED]`: `password`, `secret`, `token`, `apiKey`, `authorization`, `cookie`, `ssn`, `cvv`, `otp`, `credential`, `pin`, `privateKey`, `creditCard`, `setCookie` and similar, matched ignoring case, `_`, `-` and camelCase. Add your own with `audit({ redact: ["dob", /^diagnosis/] })`.

<!-- test -->
```ts
import { diff, redact, redactor } from "@miujs/audit";

const changes = diff({ name: "Ann", password: "a" }, { name: "Ann B", password: "b" });
// { name: { before: "Ann", after: "Ann B" }, password: { before: "a", after: "b" } }

const isSecret = redactor(["dob"]);
console.log(redact(changes, isSecret)); // password -> "[REDACTED]"
console.log(redact({ dob: "1990-01-01", city: "Hanoi" }, isSecret)); // { dob: "[REDACTED]", city: "Hanoi" }
```

## Sign-in events

With `auth: true`, the plugin records the outcome of `@miujs/auth`'s register, login and logout routes as `auth.register`, `auth.login` and `auth.logout` (resource `auth`), with `outcome`, `status` and the error `code`. Failed attempts include the attempted email; with `redactFailedLoginEmail: true` they store `emailHash` (an HMAC of the normalized address via `hashAuditEmail`) instead. The password is never read.

## Verifying the chain

`verifyChain(store, opts)` recomputes every hash and link. It detects edited rows, deleted or reordered rows, and a deleted prefix without a matching checkpoint. A deleted tail is only detectable against a `head` saved earlier with `chainHead()`, or against anchors. Keyed rows can only be recomputed with the key, so database access alone cannot forge them. `dbAuditStore` also installs a trigger that rejects `UPDATE`s on the table.

<!-- test -->
```ts
import { sqlite } from "@miujs/db";
import { chainHead, dbAuditStore, purgeOlderThan, verifyChain } from "@miujs/audit";

const key = "replace-with-32-or-more-random-characters";
const store = dbAuditStore(sqlite("app.db"), { key });
await store.append({ ts: Date.now(), action: "export", resource: "patients", actor: "alice" });

const head = await chainHead(store); // save { seq, hash } outside the database
const result = await verifyChain(store, { keys: key, head: head ?? undefined });
if (!result.ok) console.error(`broken at seq ${result.brokenAt}: ${result.reason}`);

// Retention: verifies first, deletes rows older than 6 years, appends an audit.checkpoint row.
const { purged } = await purgeOlderThan(store, 365 * 6, { keys: key });
console.log(purged);
```

Keys rotate: pass an array (or a comma-separated `AUDIT_HMAC_KEY`, newest first). The first key signs, all verify. Keys may be strings or `{ id, secret }`. Once a chain is keyed, appending without a key fails with `MIU_E_AUDIT_KEY_MISSING` rather than downgrading it. For a chain that was keyed later, pass `unkeyedThrough` (the last unkeyed seq) to `verifyChain` and `purgeOlderThan`.

## Anchoring

`anchorHead(store, sink)` writes the current head `{ seq, hash, at, keyId, signature }` to a sink outside the database's trust boundary, under `audit-anchors/<seq>.json`. Pass the anchors back as `verifyChain(store, { anchors })` to detect truncation and rewritten rows. With keys, unsigned anchors are refused.

Sinks: any object with `put(key, value)` (an R2 bucket or KV namespace), a binding name resolved from `env`, `fileSink(path)` (Bun/Node, one JSON line per anchor) or `httpSink(url)`.

<!-- test -->
```ts
import { anchorJob, fileSink, memoryAuditStore, verifyChain } from "@miujs/audit";

const store = memoryAuditStore({ key: "replace-with-32-or-more-random-characters" });
await store.append({ ts: Date.now(), action: "view", resource: "patients", actor: "bob" });

const sink = fileSink("./audit-anchors.jsonl");
const job = anchorJob({ store, sink });
await job(); // schedule this, e.g. hourly

const check = await verifyChain(store, { anchors: await sink.read() });
console.log(check.ok);
```

## Options

`audit(options)`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `store` | `AuditStore` | required | `memoryAuditStore()` for dev, `dbAuditStore(database)` for real apps. |
| `redact` | `(string \| RegExp)[]` | `[]` | Extra keys to redact on top of the built-in list. |
| `auth` | `boolean` | `false` | Log `auth_login` / `auth_logout` / `auth_register` outcomes. |
| `permission` | `string` | `"audit:read"` | Permission for `GET /audit` when `ctx.can` exists; otherwise the `admin` role is required. |
| `routes` | `boolean` | `true` | Serve `GET /audit`. |
| `path` | `string` | `"/audit"` | Path of the query route. |
| `key` | `AuditKeys` | `env.AUDIT_HMAC_KEY` | HMAC key(s), 32+ characters; first signs, all verify. |
| `redactFailedLoginEmail` | `boolean` | `false` | Store `emailHash` instead of the email on failed sign-ins. |
| `emailSalt` | `string` | the audit key | Salt for `emailHash`, 32+ characters. With neither, the email is dropped. |

Stores: `memoryAuditStore({ key? })` and `dbAuditStore(database, { key?, table? })` (default table `audit_log`).

## Errors

- [`MIU_E_AUDIT_STORE_MISSING`](../../docs/errors.md#miu_e_audit_store_missing): `audit()` without a store.
- [`MIU_E_AUDIT_KEY_WEAK`](../../docs/errors.md#miu_e_audit_key_weak): a key or `emailSalt` shorter than 32 characters.
- [`MIU_E_AUDIT_KEY_MISSING`](../../docs/errors.md#miu_e_audit_key_missing): appending to a keyed chain without a key.
- [`MIU_E_AUDIT_INVALID`](../../docs/errors.md#miu_e_audit_invalid): entry without a non-empty `action` and `resource`.
- [`MIU_E_AUDIT_QUERY_INVALID`](../../docs/errors.md#miu_e_audit_query_invalid): 400, bad `limit`, `since`/`until` or `cursor`.
- [`MIU_E_AUDIT_ORG_MISMATCH`](../../docs/errors.md#miu_e_audit_org_mismatch): 403, `GET /audit?org=` for an org other than the active one.
- [`MIU_E_AUDIT_APPEND_CONFLICT`](../../docs/errors.md#miu_e_audit_append_conflict): 503, too many concurrent writers.
- [`MIU_E_AUDIT_CHAIN_BROKEN`](../../docs/errors.md#miu_e_audit_chain_broken): `purgeOlderThan` refused because verification failed.
- [`MIU_E_AUDIT_RETENTION_INVALID`](../../docs/errors.md#miu_e_audit_retention_invalid): bad `days` for `purgeOlderThan`.
- [`MIU_E_AUDIT_TABLE_INVALID`](../../docs/errors.md#miu_e_audit_table_invalid): bad `dbAuditStore` table name.
- [`MIU_E_AUDIT_SINK_MISSING`](../../docs/errors.md#miu_e_audit_sink_missing), [`MIU_E_AUDIT_SINK_UNSUPPORTED`](../../docs/errors.md#miu_e_audit_sink_unsupported), [`MIU_E_AUDIT_SINK_INVALID`](../../docs/errors.md#miu_e_audit_sink_invalid), [`MIU_E_AUDIT_ANCHOR_FAILED`](../../docs/errors.md#miu_e_audit_anchor_failed), [`MIU_E_AUDIT_ANCHOR_INVALID`](../../docs/errors.md#miu_e_audit_anchor_invalid): anchoring problems.

See [all error codes](../../docs/errors.md).

## Cloudflare Workers

- `dbAuditStore(d1("DB"))` resolves the D1 database from `env` per request and declares the `d1` binding for `miu deploy cloudflare`.
- `AUDIT_HMAC_KEY` is read from `env` per request (set it with `wrangler secret put AUDIT_HMAC_KEY`). The missing-key warning is logged on the first request instead of at startup.
- Anchor to an R2 bucket or KV namespace by binding name: `anchorJob({ store, sink: "AUDIT_ANCHORS" })`, and register `job.scheduled` as the Workers `scheduled` handler. `fileSink()` does not work on Workers (`MIU_E_AUDIT_SINK_UNSUPPORTED`).
- `memoryAuditStore()` loses entries when the isolate is recycled; the plugin warns when it is used outside dev.

## Links

- [Getting started guide](../../docs/guide.md)
- [Error codes](../../docs/errors.md)
- [AGENTS.md](../../AGENTS.md)
- [Source](./src)
- [Tests](./test)
- [@miujs/db](../db/README.md)
- [@miujs/access](../access/README.md)
- [@miujs/auth](../auth/README.md)
- [@miujs/session](../session/README.md)
