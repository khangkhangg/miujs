import { expect, test } from "bun:test";
import { connect } from "@miujs/realtime/client";
import app from "../app.ts";

test("serves the web client and hands out 6-digit game codes that resolve to the room", async () => {
  const page = await app.request("/");
  expect(page.headers.get("content-type")).toContain("text/html");
  expect(await page.text()).toContain("MiuJS Quiz");
  const res = await app.request("/api/games", { method: "POST" });
  const body = await res.json();
  expect(body.code).toMatch(/^\d{6}$/);
  expect(body.join).toBe(`/rooms/quiz/${body.id}`);
  const found = await app.request(`/rooms/code/${body.code}`);
  expect(await found.json()).toEqual({ type: "quiz", id: body.id });
});

test("host and player play over real WebSockets; the question arrives without its answer", async () => {
  const s = await app.listen(0);
  try {
    const created = await (await fetch(s.url + "api/games", { method: "POST" })).json();
    const url = s.url.replace("http", "ws") + `rooms/quiz/${created.id}`;
    const host = connect(url, { name: "Host", role: "host", hostKey: created.hostKey });
    await host.ready;
    const ann = connect(url, { name: "Ann" });
    await ann.ready;
    expect(ann.me?.role).toBe("player");
    const raw: string[] = [];
    ann.socket!.addEventListener("message", (e) => raw.push(String(e.data)));
    host.send("start");
    await waitFor(() => ann.state?.phase === "question");
    expect(ann.state.question.choices.length).toBe(4);
    expect(raw.join("")).not.toContain("correct");
    ann.send("answer", { choice: 0 });
    await waitFor(() => ann.state?.phase === "reveal");
    expect(typeof ann.state.reveal.correct).toBe("number");
    host.close();
    ann.close();
  } finally {
    await s.stop();
  }
});

async function waitFor(fn: () => boolean, ms = 2000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
