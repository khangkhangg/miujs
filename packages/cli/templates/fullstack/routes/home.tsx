/** @jsxImportSource @miujs/web */
// A server-rendered page with an htmx counter: the button POSTs, the route answers with the new
// fragment, and htmx swaps it in. No client-side JavaScript of our own.

import { route, type CallFn } from "miujs";
import { render, renderPage } from "@miujs/web";
import { Layout } from "../components/Layout.tsx";

let clicks = 0; // in memory: resets on restart (use @miujs/db for real data)

function Counter(props: { count: number }) {
  return (
    <p id="counter">
      Clicked <strong>{props.count}</strong> {props.count === 1 ? "time" : "times"}.{" "}
      <button hx-post="/clicks" hx-target="#counter" hx-swap="outerHTML">
        Click me
      </button>
    </p>
  );
}

export const home = route.get("/", {
  summary: "The home page",
  mcp: false,
  handler: (ctx) =>
    renderPage(
      ctx,
      <main>
        <h1>__APP_NAME__</h1>
        <p>Server-rendered JSX with htmx. Edit routes/home.tsx.</p>
        <Counter count={clicks} />
      </main>,
      (body) => <Layout title="__APP_NAME__">{body}</Layout>,
    ),
});

export const click = route.post("/clicks", {
  summary: "Count a click and return the updated counter fragment",
  auth: "optional", // public on purpose: anyone may click
  handler: () => render(<Counter count={++clicks} />),
});

export const tests = {
  "home renders the page with htmx": async (call: CallFn) => {
    const res = (await call(home)).expectStatus(200);
    if (!res.headers.get("content-type")?.includes("text/html")) throw new Error("expected HTML");
    if (!res.text.startsWith("<!doctype html><html")) throw new Error("expected a full document with a doctype");
    if (!res.text.includes("htmx.org") || !res.text.includes('hx-post="/clicks"')) throw new Error("expected the htmx counter");
  },
  "clicking returns just the counter fragment": async (call: CallFn) => {
    const before = clicks;
    const res = (await call(click)).expectStatus(200);
    if (!res.text.startsWith('<p id="counter">')) throw new Error(`expected a fragment, got ${res.text.slice(0, 60)}`);
    if (!res.text.includes(`<strong>${before + 1}</strong>`)) throw new Error("expected the count to go up");
  },
};
