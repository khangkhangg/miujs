import { Miu, t, HttpError, mcp, openapi } from "miujs";

const Todo = t.object({ id: t.integer(), title: t.string(), done: t.boolean() });
const todos = new Map<number, { id: number; title: string; done: boolean }>();
let nextId = 1;

const app = new Miu({ name: "{{name}}", version: "0.1.0" })
  .use(openapi()) // GET  /openapi.json
  .use(mcp()) //     POST /mcp — every route below is also an agent tool
  .get("/", { summary: "Say hello" }, () => "Hello from {{name}}!")
  .get("/todos", { summary: "List todos", response: t.object({ items: t.array(Todo) }) }, () => ({
    items: [...todos.values()],
  }))
  .get("/todos/:id", { summary: "Get a todo", params: t.object({ id: t.integer() }), response: Todo }, (c) => {
    const todo = todos.get(c.params.id);
    if (!todo) throw new HttpError(404, "Todo not found");
    return todo;
  })
  .post("/todos", { summary: "Create a todo", body: t.object({ title: t.string({ min: 1, max: 200 }) }), response: Todo }, (c) => {
    const todo = { id: nextId++, title: c.body.title, done: false };
    todos.set(todo.id, todo);
    c.status(201);
    return todo;
  });

export default app;
