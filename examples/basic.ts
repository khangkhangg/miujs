// bun examples/basic.ts  ->  http://localhost:3000
import { Miu, t, HttpError, mcp, openapi } from "../src/index.ts";

const todos = new Map<number, { id: number; title: string; done: boolean }>();
let nextId = 1;

const Todo = t.object({ id: t.integer(), title: t.string(), done: t.boolean() });

const app = new Miu({ name: "todo-api", version: "0.1.0", description: "Example Miu app" })
  .use(openapi()) // GET /openapi.json
  .use(mcp()) // POST /mcp  (every route below is an agent tool)
  .get("/todos", { summary: "List todos", response: t.object({ items: t.array(Todo) }) }, () => ({
    items: [...todos.values()],
  }))
  .get(
    "/todos/:id",
    { summary: "Get a todo", params: t.object({ id: t.integer() }), response: Todo },
    (c) => todos.get(c.params.id) ?? notFound(),
  )
  .post(
    "/todos",
    { summary: "Create a todo", body: t.object({ title: t.string({ min: 1, max: 200 }) }), response: Todo },
    (c) => {
      const todo = { id: nextId++, title: c.body.title, done: false };
      todos.set(todo.id, todo);
      c.status(201);
      return todo;
    },
  )
  .patch(
    "/todos/:id",
    {
      summary: "Update a todo",
      params: t.object({ id: t.integer() }),
      body: t.object({ title: t.optional(t.string()), done: t.optional(t.boolean()) }),
      response: Todo,
    },
    (c) => {
      const todo = todos.get(c.params.id) ?? notFound();
      Object.assign(todo, Object.fromEntries(Object.entries(c.body).filter(([, v]) => v !== undefined)));
      return todo;
    },
  )
  .delete("/todos/:id", { summary: "Delete a todo", params: t.object({ id: t.integer() }) }, (c) => {
    if (!todos.delete(c.params.id)) notFound();
  });

function notFound(): never {
  throw new HttpError(404, "Todo not found");
}

// Bun serves a default export that has `fetch` automatically (port 3000 or $PORT).
// Don't also call app.listen() in the same entry file, or the port is bound twice.
export default app;
