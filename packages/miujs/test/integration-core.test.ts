import { afterEach, expect, test } from "bun:test";
import { definePlugin, miu, processEnv, route, serializeCookie, targetRuntime } from "../src/index.ts";

afterEach(() => {
  delete process.env.MIU_TARGET;
});

test("targetRuntime() is the detected runtime by default", () => {
  expect(targetRuntime()).toBe("bun");
});

test("MIU_TARGET=cloudflare makes targetRuntime() report workerd", () => {
  process.env.MIU_TARGET = "cloudflare";
  expect(targetRuntime()).toBe("workerd");
});

test("processEnv and serializeCookie are exported for batteries", () => {
  process.env.MIU_PROBE = "1";
  expect(processEnv().MIU_PROBE).toBe("1");
  delete process.env.MIU_PROBE;
  expect(serializeCookie("a", "b")).toStartWith("a=b");
});

test("cookies set in an onResponse hook reach the response", async () => {
  const app = miu({
    routes: [route.get("/", { handler: () => "ok" })],
    plugins: [definePlugin({ name: "late-cookie", onResponse: (ctx) => void ctx.cookies.set("late", "1") })],
  });
  const res = await app.fetch(new Request("http://localhost/"));
  expect(res.headers.get("set-cookie")).toContain("late=1");
});
