import { describe, expect, test } from "bun:test";
import { createLogger, miu, route, t, validate, type Context, type ManageAction, type ManageSection } from "miujs";
import { ai, anthropic, tool } from "../src/index.ts";
import { fakeFetch, json } from "./helpers.ts";

const KEY = "sk-ant-manage-secret-key";
const env = { ANTHROPIC_API_KEY: KEY };
let ids = 0;
const reply = (content: unknown[], stop = "end_turn", usage = { input_tokens: 10, output_tokens: 5 }, model = "claude-opus-5-5") => json({ model, content, stop_reason: stop, usage });
const text = (s: string) => ({ type: "text", text: s });
const use = (name: string, input: unknown) => ({ type: "tool_use", id: `toolu_${++ids}`, name, input });

const add = tool({ name: "add", description: "Add", input: t.object({ a: t.number(), b: t.number() }), run: ({ a, b }) => ({ sum: a + b }) });

function setup(f: ReturnType<typeof fakeFetch>, opts: { model?: string } = {}) {
  const plugin = ai({ provider: anthropic(), fetch: f, ...opts });
  const hello = route.get("/hello", { handler: async ({ ai }) => (await ai.generate({ prompt: "Hi" })).text });
  const agent = route.get("/agent", { handler: async ({ ai }) => (await ai.run({ prompt: "2+3?", tools: [add] })).text });
  const app = miu({ routes: [hello, agent], plugins: [plugin], logLevel: "silent" });
  const [section] = plugin.manage() as ManageSection[];
  const ctx = { runtime: "workerd", env, log: createLogger("silent") } as unknown as Context;
  const get = (path: string) => app.dispatch(new Request(`http://localhost${path}`), env, { runtime: "workerd" });
  return { plugin, app, section, ctx, get };
}

function action(actions: ManageAction[] | undefined, name: string): ManageAction {
  const a = actions?.find((x) => x.name === name);
  if (!a) throw new Error(`no action ${name}`);
  return a;
}

const statOf = (st: any, label: string) => st.stats.find((x: any) => x.label === label)?.value;

describe("ai manage()", () => {
  test("one 'ai' section with status, settings and a test prompt action", () => {
    const { section } = setup(fakeFetch(reply([text("hi")])));
    expect(section.id).toBe("ai");
    expect(section.settings).toBeTruthy();
    expect(section.actions!.map((a) => a.name)).toEqual(["testPrompt"]);
  });

  test("status shows provider and model names, request/token counters, tool calls and errors", async () => {
    const f = fakeFetch(
      reply([text("Hello")]),
      reply([use("add", { a: 2, b: 3 })], "tool_use"),
      reply([text("5")], "end_turn", { input_tokens: 20, output_tokens: 1 }, "claude-sonnet-5"),
      json({ type: "error", error: { type: "invalid_request_error", message: "bad" } }, 400),
    );
    const { section, ctx, get } = setup(f);
    const fresh = await section.status!(ctx);
    expect(statOf(fresh, "Requests")).toBe(0);
    expect(statOf(fresh, "Provider")).toBe("anthropic");
    expect(statOf(fresh, "Model")).toBe("claude-opus-5-5");

    expect((await get("/hello")).status).toBe(200);
    expect((await get("/agent")).status).toBe(200);
    expect((await get("/hello")).status).toBe(500);
    const st = await section.status!(ctx);
    expect(statOf(st, "Requests")).toBe(3);
    expect(statOf(st, "Input tokens")).toBe(40);
    expect(statOf(st, "Output tokens")).toBe(11);
    expect(statOf(st, "Tool calls")).toBe(1);
    expect(statOf(st, "Errors")).toBe(1);
    expect(statOf(st, "Last error")).toBe("MIU_E_AI_BAD_REQUEST");
    expect(st.stats!.find((x) => x.label === "Requests")!.hint).toContain("isolate");
    const byModel = st.tables!.find((x) => x.title === "By model")!;
    expect(byModel.rows).toEqual([
      { model: "claude-opus-5-5", requests: 2, inputTokens: 20, outputTokens: 10, errors: 1 },
      { model: "claude-sonnet-5", requests: 1, inputTokens: 20, outputTokens: 1, errors: 0 },
    ]);
    expect(JSON.stringify(st)).not.toContain(KEY);
  });

  test("the per-model table is bounded", async () => {
    let n = 0;
    const f = fakeFetch(() => reply([text("x")], "end_turn", { input_tokens: 1, output_tokens: 1 }, `model-${n++}`));
    const { section, get } = setup(f);
    for (let i = 0; i < 30; i++) await get("/hello");
    const st = await section.status!({ runtime: "bun", env: {} } as unknown as Context);
    const rows = st.tables!.find((x) => x.title === "By model")!.rows;
    expect(rows.length).toBe(21);
    expect(rows[20]).toMatchObject({ model: "(other)", requests: 10 });
    expect(statOf(st, "Requests")).toBe(30);
  });

  test("settings: default model, max tokens and temperature apply to later requests", async () => {
    const f = fakeFetch(reply([text("ok")]));
    const { section, ctx, get } = setup(f);
    const s = section.settings!;
    expect(await s.get(ctx)).toEqual({ model: "claude-opus-5-5", maxTokens: 16_000, temperature: null });
    expect(validate(s.schema, { model: "", maxTokens: 100, temperature: null }).ok).toBe(false);
    expect(validate(s.schema, { model: "m", maxTokens: 0, temperature: null }).ok).toBe(false);
    expect(validate(s.schema, { model: "m", maxTokens: 100, temperature: 3 }).ok).toBe(false);
    expect(validate(s.schema, { model: null, maxTokens: 100, temperature: 0.5 }).ok).toBe(true);
    await s.set({ model: "claude-haiku-4-5", maxTokens: 512, temperature: 0.2 }, ctx);
    expect(await s.get(ctx)).toEqual({ model: "claude-haiku-4-5", maxTokens: 512, temperature: 0.2 });
    await get("/hello");
    expect(f.calls[0].body).toMatchObject({ model: "claude-haiku-4-5", max_tokens: 512, temperature: 0.2 });
    // null model falls back to the configured default.
    await s.set({ model: null, maxTokens: 512, temperature: null }, ctx);
    await get("/hello");
    expect(f.calls[1].body.model).toBe("claude-opus-5-5");
    expect(f.calls[1].body.temperature).toBeUndefined();
  });

  test("testPrompt sends a short prompt and returns the reply and usage, rate limited", async () => {
    const f = fakeFetch(reply([text("pong")]));
    const { section, ctx } = setup(f);
    const run = action(section.actions, "testPrompt");
    expect(validate(run.input!, { prompt: "" }).ok).toBe(false);
    expect(validate(run.input!, { prompt: "x".repeat(4_001) }).ok).toBe(false);
    expect(validate(run.input!, { prompt: "ping", maxTokens: 5_000 }).ok).toBe(false);
    const out: any = await run.run({ prompt: "ping" }, ctx);
    expect(out).toMatchObject({ text: "pong", model: "claude-opus-5-5", usage: { inputTokens: 10, outputTokens: 5 }, stopReason: "end_turn" });
    expect(f.calls[0].body.max_tokens).toBe(256);
    expect(JSON.stringify(out)).not.toContain(KEY);
    for (let i = 0; i < 4; i++) await run.run({ prompt: "ping" }, ctx);
    await expect(Promise.resolve().then(() => run.run({ prompt: "ping" }, ctx))).rejects.toMatchObject({ code: "MIU_E_AI_TEST_RATE_LIMITED", status: 429 });
    expect(statOf(await section.status!(ctx), "Requests")).toBe(5);
  });

  test("testPrompt surfaces provider errors without leaking the key", async () => {
    const { section } = setup(fakeFetch(reply([text("x")])));
    const err: any = await Promise.resolve()
      .then(() => action(section.actions, "testPrompt").run({ prompt: "ping" }, { runtime: "workerd", env: {}, log: createLogger("silent") } as unknown as Context))
      .catch((e) => e);
    expect(err.code).toBe("MIU_E_AI_MISSING_KEY");
  });
});
