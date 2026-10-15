# Porting a FastAPI app to MiuJS

FastAPI already publishes its contract at `/openapi.json`, and its Pydantic models map almost one
to one onto `t`. That makes it the most mechanical of the three ports.

## 1. Generate everything you can

```ts
import { fromOpenApi, pydanticToT } from "@miujs/migrate";

const spec = await (await fetch("http://fastapi:8000/openapi.json")).json();
const { files, routes, warnings } = fromOpenApi(spec);   // schemas.ts + routes/<resource>.ts + routes/index.ts
// For a single model: pydanticToT(Model.model_json_schema()) → module with `export const Model = t.object(...)`.
```

- Every stub has the route's `params`, `query`, `body`, `response` and `status`, and is tagged
  `"not-ported"`.
- The proxy keeps sending tagged routes to FastAPI.
- To port a route: write the handler, remove the tag, then run `verifyContracts`.
- Read `warnings`. They list anything inexact: tuples, non-JS regex patterns, unknown `$ref`s.
  Numeric `gt` and `lt` bounds produce a code comment, because `t.number` bounds are inclusive.

## 2. Put MiuJS in front

```ts
miu({
  routes: [routes],
  plugins: [captureMiddleware({ sink: jsonlFileSink("contracts.jsonl") }), migrateProxy({ upstream: "http://fastapi:8000" })],
});
```

- FastAPI apps usually authenticate with bearer tokens (OAuth2/JWT), not cookies. Validate the same
  JWT in a MiuJS plugin that sets `ctx.user`, or move clients to `@miujs/auth` API tokens.
- If the FastAPI app uses Starlette's `SessionMiddleware` (an itsdangerous-signed cookie), write a
  small `LegacySessionSource` for it. That format is not built in yet.

## 3. Mappings

| FastAPI | MiuJS |
|---|---|
| `@app.get("/items/{item_id}")` | `route.get("/items/:item_id", …)` |
| `item_id: int` path param | `params: t.object({ item_id: t.integer() })` (query/params are coerced from strings) |
| `q: str \| None = None` | `query: t.object({ q: t.optional(t.nullable(t.string())) })` |
| `limit: int = Query(10, ge=1, le=100)` | `limit: t.default(t.integer({ min: 1, max: 100 }), 10)` |
| `body: ItemCreate` (Pydantic) | `body: ItemCreate` (generated `t.object`) |
| `response_model=Item` | `response: Item` (checked in dev) |
| `status_code=201` | `status: 201` |
| `Field(min_length=1, max_length=50)` | `t.string({ minLength: 1, maxLength: 50 })` |
| `EmailStr` | `t.string({ format: "email" })` |
| `Literal["a", "b"]` / `Enum` | `t.enum(["a", "b"])` |
| `dict[str, int]` | `t.record(t.integer())` |
| `Depends(get_db)` | `ctx.db` from `@miujs/db` |
| `Depends(get_current_user)` | `auth: "required"` + `ctx.user` |
| `HTTPException(404, "…")` | `throw errors.notFound("Item", id)` |
| `BackgroundTasks.add_task(f)` | `ctx.waitUntil(f())` or `@miujs/queue` |
| SQLAlchemy `session.query(User).filter(...)` | SQL via `db.prepare(...)` or Drizzle |
| Middleware (`@app.middleware("http")`) | plugin `onRequest` / `onResponse` |
| `APIRouter(prefix="/v1")` | one module per resource; prefix in the path |
| Alembic | `@miujs/db` `migrate()` after cut-over |

**Error shape:** FastAPI returns `422 {"detail": [...]}` on validation errors. MiuJS returns
`400 {"error": {"code": "MIU_E_VALIDATION", ...}}`. Clients that parse `detail` need a
compatibility `onResponse` plugin until they are updated. `verifyContracts` flags these as status
diffs.

## 4. Traps

1. **Request-scoped globals.** `contextvars` and module-level caches that were safe per worker
   are shared across every concurrent request in one JS process. Use `ctx`.
2. **Missing `await`.** Sync `def` endpoints with SQLAlchemy become async in MiuJS. Every
   `@miujs/db` call must be awaited, or the handler returns before the write happens.
3. **N+1 from lazy loading.** SQLAlchemy's `lazy="select"` relationships trigger a query per
   access. Load related rows in one `IN (…)` query.
4. **Timezones.**
   - Pydantic serializes naive `datetime` without an offset, and aware ones with `+00:00` or `Z`
     depending on the version.
   - JS `Date` always prints `…Z`.
   - Decide the wire format per field, and keep the old one if clients parse it.
5. **Integers.** Python ints are unbounded; JS numbers lose precision above 2^53. Keep large IDs
   (snowflakes) as strings.
6. **Optional vs default.** `x: int | None` without a default is *required but nullable* in
   Pydantic v2. The generator keeps that distinction: required keys stay required.
7. **Trailing slashes.** FastAPI redirects `/items/` to `/items` with a 307. MiuJS normalizes
   paths, but check clients that post to the slash form.
