import { expect, test } from "bun:test";
import { definePlugin, errors, miu } from "../src/index.ts";

declare module "../src/index.ts" {
  interface Services {
    mailer: { send(to: string): string };
  }
}

test("plugins provide services that background code can use without a request", async () => {
  const app = miu({
    plugins: [definePlugin({ name: "mail", setup(a) { a.provide("mailer", { send: (to: string) => `sent to ${to}` }); } })],
  });
  await app.ready();
  expect(app.service("mailer").send("a@b.co")).toBe("sent to a@b.co");
  expect(app.hasService("mailer")).toBe(true);
});

test("a missing service fails with a fix", async () => {
  const app = miu({});
  await app.ready();
  expect(() => app.service("mailer")).toThrow(expect.objectContaining({ code: "MIU_E_SERVICE_MISSING" }));
});

test("providing the same service twice fails at startup", async () => {
  const mk = (name: string) => definePlugin({ name, setup(a) { a.provide("mailer", { send: () => name }); } });
  const app = miu({ plugins: [mk("a"), mk("b")] });
  await expect(app.ready()).rejects.toMatchObject({ code: "MIU_E_SERVICE_DUPLICATE" });
});

test("MCP plugin tool errors keep the MiuError code and fix", async () => {
  const app = miu({
    mcp: true,
    plugins: [definePlugin({ name: "p", mcpTools: () => [{ name: "boom", inputSchema: { type: "object" }, call: () => { throw errors.forbidden("No access", "Ask an admin for the reports:read permission."); } }] })],
  });
  const res = await app.fetch(new Request("http://localhost/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "boom", arguments: {} } }) }));
  const out = (await res.json()).result;
  expect(out.isError).toBe(true);
  const body = JSON.parse(out.content[0].text);
  expect(body.error).toMatchObject({ code: "MIU_E_FORBIDDEN", fix: "Ask an admin for the reports:read permission." });
});
