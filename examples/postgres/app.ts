// Todos on Postgres. Bun / Node: a pooled connection from DATABASE_URL. Cloudflare Workers: a
// client per request through the Hyperdrive binding HYPERDRIVE (see wrangler.toml).
//
//   DATABASE_URL=postgres://postgres:postgres@localhost:5432/todos bun migrate.ts
//   DATABASE_URL=postgres://postgres:postgres@localhost:5432/todos bun serve.ts
import { asc, count, eq, sql } from "drizzle-orm";
import { errors, miu, route, t } from "miujs";
import { fromPgError, pg, type PgOptions } from "@miujs/db/postgres";
import { schema, todos } from "./schema.ts";

const todo = t.object({ id: t.integer(), title: t.string(), done: t.boolean(), createdAt: t.string() });
type TodoRow = typeof todos.$inferSelect;
const out = (r: TodoRow) => ({ id: r.id, title: r.title, done: r.done, createdAt: r.createdAt.toISOString() });

export function createApp(opts: Omit<PgOptions<typeof schema>, "schema"> = {}) {
  const database = pg({ schema, ...opts });

  const listTodos = route.get("/todos", {
    summary: "List todos, oldest first",
    response: t.object({ todos: t.array(todo) }),
    handler: async (ctx) => ({ todos: (await database.orm(ctx).select().from(todos).orderBy(asc(todos.id))).map(out) }),
  });

  const createTodo = route.post("/todos", {
    summary: "Create a todo (titles are unique)",
    body: t.object({ title: t.string({ minLength: 1, maxLength: 200 }) }),
    response: todo,
    handler: async (ctx) => {
      try {
        const [row] = await database.orm(ctx).insert(todos).values({ title: ctx.body.title }).returning();
        return out(row);
      } catch (err) {
        // A unique violation becomes a 409 MIU_E_CONFLICT; anything else stays a 500.
        throw fromPgError(err) ?? err;
      }
    },
  });

  const completeTodo = route.post("/todos/:id/done", {
    summary: "Mark a todo done",
    params: t.object({ id: t.integer() }),
    response: todo,
    handler: async (ctx) => {
      const [row] = await database.orm(ctx).update(todos).set({ done: true }).where(eq(todos.id, ctx.params.id)).returning();
      if (!row) throw errors.notFound("todo", ctx.params.id);
      return out(row);
    },
  });

  const completeAll = route.post("/todos/complete-all", {
    summary: "Mark every todo done, in one transaction",
    response: t.object({ updated: t.integer() }),
    handler: async (ctx) =>
      // Keep transactions short and inside one request: on Hyperdrive a transaction holds one
      // pooled connection until it commits.
      database.orm(ctx).transaction(async (tx) => {
        const open = await tx.select({ n: count() }).from(todos).where(eq(todos.done, false));
        await tx.update(todos).set({ done: true }).where(eq(todos.done, false));
        return { updated: open[0].n };
      }),
  });

  const deleteTodo = route.delete("/todos/:id", {
    summary: "Delete a todo",
    params: t.object({ id: t.integer() }),
    handler: async (ctx) => {
      // Raw SQL with the postgres.js tagged template: values are always sent as parameters.
      const rows = await ctx.sql`DELETE FROM todos WHERE id = ${ctx.params.id} RETURNING id`;
      if (!rows.length) throw errors.notFound("todo", ctx.params.id);
    },
  });

  const stats = route.get("/stats", {
    summary: "How many todos, and how many are done",
    response: t.object({ total: t.integer(), done: t.integer() }),
    handler: async (ctx) => {
      const [row] = await database.orm(ctx).select({ total: count(), done: sql<number>`count(*) FILTER (WHERE ${todos.done})::int` }).from(todos);
      return row;
    },
  });

  return miu({
    name: "postgres-todos",
    routes: [listTodos, createTodo, completeTodo, completeAll, deleteTodo, stats],
    plugins: [database],
    mcp: true,
    logLevel: "silent",
  });
}

export default createApp({ localConnectionString: "postgres://postgres:postgres@localhost:5432/todos" });
