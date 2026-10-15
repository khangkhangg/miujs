# Porting a Django app to MiuJS

Port one view at a time. Django keeps serving the rest, and logins are shared through Django's
`django_session` table.

## 1. Put MiuJS in front

```ts
import { migrateProxy, captureMiddleware, jsonlFileSink, bridgeAuth, djangoSession, djangoDatabaseStore } from "@miujs/migrate";

const django = djangoSession({
  secretKey: process.env.DJANGO_SECRET_KEY!,     // SECRET_KEY
  secretKeyFallbacks: [],                        // SECRET_KEY_FALLBACKS
  store: djangoDatabaseStore(legacyDb),          // SESSION_ENGINE = "django.contrib.sessions.backends.db"
  passwordHashFor: (id) => users.passwordHash(id), // checks _auth_user_hash like Django does
});

miu({
  routes: [routes],
  plugins: [
    captureMiddleware({ sink: jsonlFileSink("contracts.jsonl") }),
    migrateProxy({ upstream: "http://django:8000" }),
    auth(),
    bridgeAuth({ from: django, findUser }),
  ],
});
```

- **Session backends:**
  - `cached_db` stores the same rows, so `djangoDatabaseStore` works for it.
  - `signed_cookies` needs `djangoSignedCookieStore()`.
  - Pure `cache` sessions need a custom `DjangoSessionStore` that reads your cache.
- **Login on both apps:** call `django.login(ctx, user.id, { passwordHash })`.
  - Django rejects sessions that have no `_auth_user_hash`, so the password hash is required.
  - This writes a `django_session` row and sets `sessionid`.
- **Serializer:** only Django's default `JSONSerializer` sessions are supported. `PickleSerializer`
  (removed in Django 5.0) is refused.
- **`USE_TZ`:** `expire_date` is compared in UTC. With `USE_TZ = False`, pass
  `djangoDatabaseStore(db, { utcOffsetMinutes })` with the server's offset.
- **Passwords:** Django's `pbkdf2_sha256$…` hashes are verified by `@miujs/auth` as they are, so
  users keep their passwords.

## 2. Generate route stubs

For DRF, generate a schema with drf-spectacular (`./manage.py spectacular --format openapi-json`),
then pass it to `fromOpenApi(spec)`. Stubs are tagged `"not-ported"` until you write them.

## 3. Mappings

| Django | MiuJS |
|---|---|
| `path("users/<int:id>/", views.user_detail)` | `route.get("/users/:id", { params: t.object({ id: t.integer() }) })` |
| `@login_required` / `IsAuthenticated` | `auth: "required"` |
| `@permission_required("app.change_post")` / DRF permissions | `permission: "posts.change"` + `@miujs/access` |
| DRF `Serializer` / Django `Form` | `body`/`response` `t` schemas |
| `serializers.CharField(max_length=100, required=False, allow_null=True)` | `t.optional(t.nullable(t.string({ maxLength: 100 })))` |
| `ChoiceField(choices=...)` | `t.enum([...])` |
| `get_object_or_404(User, pk=id)` | `const u = await db…first(); if (!u) throw errors.notFound("User", id)` |
| `User.objects.filter(active=True).order_by("-id")[:20]` | `SELECT … WHERE active = 1 ORDER BY id DESC LIMIT 20` (or Drizzle) |
| `select_related` / `prefetch_related` | a JOIN, or one `IN (…)` query per relation |
| `transaction.atomic()` | `db.batch([...])` |
| Migrations | keep Django's until cut-over, then `@miujs/db` `migrate()` |
| Middleware (`__call__(request)`) | plugin `onRequest` / `onResponse` |
| Celery `task.delay(...)` | `@miujs/queue` `ctx.queue.send(...)` |
| `send_mail` | `@miujs/mail` |
| `request.session["k"]` | `ctx.session` (`@miujs/session`); the old one through `getLegacySession(ctx)` |
| `django.core.cache` | `@miujs/cache` |
| `settings.X` | `ctx.env.X` |
| Signals (`post_save`) | call the function explicitly after the write, or use `@miujs/audit` |

## 4. Traps

1. **Request-scoped globals.** Thread-locals, such as `get_current_request()`-style middleware, have
   no direct equivalent. Module state is shared by every request in the process, so pass `ctx`
   instead.
2. **Missing `await`.** The Django ORM is synchronous. Every `@miujs/db` call returns a Promise. A
   forgotten `await` turns `if (!row)` into dead code.
3. **N+1 queries.** Accessing `obj.author` inside a loop issues one query per row. Ported literally,
   that becomes one awaited round trip per row, which is far worse on D1. Batch the lookups.
4. **Timezones.**
   - Django stores aware datetimes in UTC and DRF renders them with an offset, such as
     `2024-05-01T10:00:00Z` or `+00:00` depending on settings.
   - `TIME_ZONE` affects naive values and template rendering only.
   - `Date#toISOString()` always writes `Z` with milliseconds, so compare formats with
     `verifyContracts` before switching.
5. **`Decimal` serialization.** DRF renders `DecimalField` as a string by default
   (`COERCE_DECIMAL_TO_STRING`). Keep strings where clients expect them.
6. **Trailing slashes.** `APPEND_SLASH` redirects `/users` to `/users/`. MiuJS routes match exactly,
   so declare the slash form the clients actually use.
7. **CSRF.** Django's `csrftoken` doesn't protect MiuJS routes. `bridgeAuth` therefore requires a
   same-origin `Origin` or `Referer` on unsafe methods that arrive with a legacy session.
8. **Pagination shapes.** DRF's `{count, next, previous, results}` uses absolute URLs in
   `next`/`previous`. Rebuild them from the public origin, not the internal one.
