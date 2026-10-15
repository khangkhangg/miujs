# Porting a Laravel app to MiuJS

For coding agents and humans. Work one route at a time. The Laravel app keeps serving everything
you haven't ported yet, and users stay logged in on both apps.

## 1. Put MiuJS in front

```ts
import { miu } from "miujs";
import { auth } from "@miujs/auth";
import { sqlite } from "@miujs/db";
import { migrateProxy, captureMiddleware, jsonlFileSink, bridgeAuth, laravelSession, laravelDatabaseStore } from "@miujs/migrate";
import * as routes from "./routes/index.ts";

const legacyDb = /* a D1-compatible Database for the Laravel DB, or a custom store */;
const laravel = laravelSession({
  appKey: process.env.LARAVEL_APP_KEY!,          // APP_KEY, including "base64:"
  previousKeys: [],                               // APP_PREVIOUS_KEYS
  store: laravelDatabaseStore(legacyDb),          // SESSION_DRIVER=database, table "sessions"
  lifetime: 120,                                  // SESSION_LIFETIME (minutes)
});

export default miu({
  routes: [routes],
  plugins: [
    captureMiddleware({ sink: jsonlFileSink("contracts.jsonl"), sample: 0.1 }),
    migrateProxy({ upstream: "http://laravel:8000" }),
    auth(),
    bridgeAuth({ from: laravel, findUser: (id) => users.find(id) }),
  ],
});
```

- **Order matters.** The capture plugin goes first, so it sees proxied requests. `migrateProxy` must
  come before anything that reads the body. `bridgeAuth` goes after your own `auth()`, and never
  replaces a user that `auth()` has already set.
- **Not proxied:** WebSocket upgrades. They get a 501 `MIU_E_MIGRATE_WEBSOCKET`. Route
  `/broadcasting`, Reverb and Pusher paths to Laravel at the load balancer.
- **When Laravel's TrustProxies trusts the MiuJS host,** set `X-Forwarded-*`. Laravel then builds
  correct URLs and sees the real client IP.

## 2. Generate route stubs

Generate an OpenAPI document with Scramble (`dedoc/scramble`) or Scribe, then:

```ts
import { fromOpenApi } from "@miujs/migrate";
const { files, routes, warnings } = fromOpenApi(JSON.parse(await Bun.file("openapi.json").text()));
```

Each stub is tagged `"not-ported"`, so `migrateProxy` keeps sending it to Laravel. To port a route:

1. Write the handler.
2. Remove the tag.
3. Run `verifyContracts`.

## 3. Mappings

| Laravel | MiuJS |
|---|---|
| `Route::get('/users/{id}', [UserController::class, 'show'])` | `export const showUser = route.get("/users/:id", { params: t.object({ id: t.integer() }), handler })` |
| `Route::middleware('auth')` | `auth: "required"` on the route |
| `Gate::allows('edit-post')` / policies | `permission: "posts.edit"` + `@miujs/access` |
| `$request->validate(['email' => 'required\|email', 'age' => 'integer\|min:18'])` | `body: t.object({ email: t.string({ format: "email" }), age: t.integer({ min: 18 }) })` |
| `'name' => 'nullable\|string\|max:255'` | `name: t.optional(t.nullable(t.string({ maxLength: 255 })))` |
| `'status' => Rule::in(['a','b'])` | `status: t.enum(["a", "b"])` |
| `FormRequest` class | the route's `body`/`query` schemas, defined once |
| `abort(404)` / `ModelNotFoundException` | `throw errors.notFound("User", id)` |
| `response()->json($x, 201)` | `status: 201` and `return x` |
| JSON Resources (`UserResource`) | a plain function `toUserJson(row)` + `response: UserSchema` |
| `User::find($id)` | `db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first()` |
| `User::where('active', 1)->paginate(20)` | `SELECT … WHERE active = 1 ORDER BY id LIMIT ? OFFSET ?` (or Drizzle) |
| `$user->posts` (lazy relation) | one `SELECT … WHERE user_id IN (…)` per page, never one per row |
| `DB::transaction(fn)` | `db.batch([...])` |
| Migrations | `@miujs/db` `migrate(db, [{ id, sql }])` — or keep running Laravel's until cut-over |
| Middleware (`handle($request, $next)`) | plugin `onRequest(ctx)` / `onResponse(ctx, res)` |
| `dispatch(new SendWelcome($user))` | `@miujs/queue`: `ctx.queue.send("send-welcome", { userId })` |
| Scheduler (`$schedule->daily()`) | `@miujs/queue` / Workers cron (`app.on("scheduled")`) |
| `Mail::to($u)->send(...)` | `@miujs/mail` |
| `Auth::attempt` / Sanctum tokens | `@miujs/auth`. It verifies Laravel's bcrypt hashes (on Bun), so no password resets are needed |
| `session('key')` | `ctx.session.get("key")` (`@miujs/session`). The old session is available via `getLegacySession(ctx)` |
| `Cache::remember` | `@miujs/cache` |
| `config('app.x')` / `env()` | `ctx.env.X` |

## 4. Shared login, in both directions

- **Laravel → MiuJS:** `bridgeAuth` reads `laravel_session` and decrypts it with APP_KEY. It loads
  the row from `sessions` and takes `login_web_<sha1>` as the user id. It then calls your
  `findUser`.
- **MiuJS → Laravel:** call `laravel.login(ctx, user.id)` in your MiuJS login handler. It writes a
  `sessions` row and sets an encrypted `laravel_session` cookie, so Laravel sees the same user. Call
  `laravel.logout(ctx)` on logout.
- **Other session stores:** Redis, file, or anything else works through a custom
  `LaravelSessionStore` with `read(id, { lifetimeSeconds })`, `write` and `destroy`. Payloads are
  the raw strings Laravel stores. For Redis this is `GET <prefix><id>`, where the prefix is usually
  `laravel_database_laravel_cache_` or as configured. For files it is
  `storage/framework/sessions/<id>`.
- **Session payload support:**
  - Payloads are PHP-serialized by default. Set `serialization: "json"` if `config/session.php`
    says so.
  - Set `encrypt: true` when `SESSION_ENCRYPT=true`.
  - Objects in the session, such as the `errors` ViewErrorBag after a failed form, make the session
    unreadable by default. Pass `phpClasses: "inert"` to read them as plain data. They are never
    instantiated either way.
- **CSRF:** a legacy cookie on POST, PUT, PATCH or DELETE requires a same-origin `Origin` or
  `Referer`. Laravel's `_token` does not protect MiuJS routes.

### How the crypto was checked

`test/reference/laravel.ts` is a node:crypto (OpenSSL) port of `Illuminate\Encryption\Encrypter`
and `CookieValuePrefix`. The tests check two things:

- The WebCrypto code reads everything the reference encrypts: AES-256-CBC, AES-128-CBC,
  AES-256-GCM, and old payloads with escaped slashes.
- The reference reads everything the WebCrypto code writes.

There is also one pinned vector:

- key = bytes 0x00..0x1f
- iv = 0x10..0x1f
- `encrypt("hello")`

The login key `login_web_59ba36addc2b2f9401580f014c7f58ea4e30989d` matches the value that Laravel
apps publish. **Not yet verified:** the code has not been run against a live PHP or Laravel
install. Before go-live, capture one real `laravel_session` cookie and its `sessions` row from
staging, and add them as a test.

## 5. Traps

1. **Request-scoped globals leak in a long-running process.**
   - PHP-FPM forgets everything after each request. Bun, Node and Workers do not.
   - Never keep `currentUser`, a tenant, a locale or a "request cache" in module-level variables or
     singletons. Use `ctx` (`ctx.user`, `ctx.state`) instead.
   - Static properties copied from Laravel services, such as `static $cache = []`, grow forever and
     mix users together.
2. **Missing `await`.** Eloquent is synchronous; `@miujs/db` is async.
   - `const user = db.prepare(...).first()` gives you a Promise, which is always truthy, so
     `if (!user)` never fires.
   - Errors from un-awaited promises skip your `try`. Await every call, or return the promise.
3. **N+1 from lazy loading.**
   - `$post->author` inside a loop was already slow in Laravel, unless `with()` was used. A literal
     port turns it into one awaited query per row.
   - Fetch related rows with one `IN (…)` query (or a join), then group them in JS.
4. **Timezones.**
   - Laravel stores `DATETIME` values in `config('app.timezone')`, usually UTC, without an offset.
   - `new Date("2024-05-01 10:00:00")` parses as *local time* on most runtimes. Append `Z` or parse
     explicitly.
   - Carbon's `->toJSON()` emits `2024-05-01T10:00:00.000000Z`, with 6 fractional digits, while JS
     emits 3. Use verify's `ignore` only for fields you accept as different, not to hide drift.
5. **Integer and decimal types.**
   - MySQL `DECIMAL` arrives in Laravel as a string (`"10.50"`). A MiuJS port that returns
     `10.5` changes the contract, and `verifyContracts` reports it as a `type` diff.
   - Decide per field, and keep the string if clients depend on it.
6. **`null` vs missing.** Laravel resources often emit `"x": null`. MiuJS handlers that omit the key
   change the JSON shape.
7. **Mass assignment.** `$fillable` protection does not exist. MiuJS drops unknown body keys only
   when the route has a `body` schema, so always declare one.
8. **Flash and old input.** `back()->withInput()` depends on the session `_flash` structure. Keep
   form pages on Laravel until their POST handlers are ported together.
9. **Encrypted cookies other than the session.** `XSRF-TOKEN` and `remember_web_*` are encrypted
   the same way. Read them with `laravelCookieDecode(name, value, appKey)`.
