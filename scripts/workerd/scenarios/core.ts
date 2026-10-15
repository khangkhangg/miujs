// Core on workerd: the runtime-smoke checks over real HTTP, a ctx.upgrade WebSocket, and cold vs
// warm request latency.

import { Client, check, eq, mcp, metrics, percentiles, scenario, waitFor, type AppSpec, type Dev } from "../lib.ts";
import type { SuiteContext } from "../run.ts";

export const app: AppSpec = { name: "core", dir: "scripts/workerd/apps/core", entry: "app.ts" };

export async function run(dev: Dev, _ctx: SuiteContext) {
  const c = new Client(dev.url);
  const S = (name: string, fn: () => Promise<string | void>) => scenario("core", name, fn);

  await S("cold start: first request after wrangler is ready", async () => {
    const first = await c.get("/hello");
    check(first.status === 200, `status ${first.status}`);
    eq(first.json.runtime, "workerd", "ctx.runtime");
    const warm: number[] = [];
    for (let i = 0; i < 200; i++) warm.push((await c.get("/hello")).ms);
    const w = percentiles(warm);
    metrics.coreColdStart = { startupMs: Math.round(dev.startupMs), firstRequestMs: Math.round(first.ms * 100) / 100, warm: w };
    return `wrangler ready ${Math.round(dev.startupMs)} ms, first request ${first.ms.toFixed(1)} ms, warm p50 ${w.p50} ms`;
  });

  await S("params coercion and validation", async () => {
    eq((await c.get("/users/42")).json.id, 42, "coerced id");
    const bad = await c.get("/users/abc");
    eq([bad.status, bad.json?.error?.code], [400, "MIU_E_VALIDATION"], "bad id");
  });

  await S("JSON body and body size limit", async () => {
    eq((await c.post("/echo", { text: "xin chào" })).json.text, "xin chào", "echo");
    const big = await c.post("/echo", { text: "x".repeat(1000) });
    eq(big.status, 413, "oversized body");
  });

  await S("MiuError response and unknown route", async () => {
    const r = await c.get("/missing");
    eq([r.status, r.json?.error?.code], [404, "MIU_E_NOT_FOUND"], "missing");
    eq((await c.get("/nope")).status, 404, "no route");
  });

  await S("multiple Set-Cookie headers", async () => {
    const r = await fetch(dev.url + "/cookie");
    eq(r.headers.getSetCookie().length, 2, "cookies");
  });

  await S("ctx.ip from CF-Connecting-IP", async () => {
    const { ip } = (await c.get("/ip")).json;
    check(typeof ip === "string" && ip.length > 0, `ip was ${ip}`);
    return `ip=${ip}`;
  });

  await S("waitUntil work finishes after the response", async () => {
    const before = (await c.get("/background")).json.background;
    await c.get("/later");
    await waitFor(async () => (await c.get("/background")).json.background > before, 3000, "background counter");
  });

  await S("MCP initialize, tools/list, tools/call", async () => {
    eq((await mcp(c, "initialize")).result?.serverInfo?.name, "core", "serverInfo.name");
    const tools = (await mcp(c, "tools/list")).result.tools.map((x: { name: string }) => x.name);
    check(tools.includes("get_hello"), `tools: ${tools}`);
    const called = await mcp(c, "tools/call", { name: "get_hello", arguments: {} });
    check(JSON.stringify(called.result).includes("there"), JSON.stringify(called).slice(0, 300));
  });

  await S("WebSocket via ctx.upgrade (WebSocketPair)", async () => {
    const ws = new WebSocket(dev.ws + "/ws");
    const got: string[] = [];
    ws.addEventListener("message", (e) => got.push(String(e.data)));
    await waitFor(() => got.includes("hello"), 5000, "hello frame");
    ws.send("ping");
    await waitFor(() => got.includes("echo:ping"), 5000, "echo");
    ws.close();
  });
}
