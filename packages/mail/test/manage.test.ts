// The admin management section: transport and counters (never credentials), a bounded list of
// recent sends with masked recipients, and a test email action.
import { describe, expect, test } from "bun:test";
import { miu, validate, type Context, type ManageAction, type ManageList, type ManageSection } from "miujs";
import { createMailer, httpTransport, mail, maskAddress, memoryTransport, RECENT_SENDS, resendTransport, type MailTransport } from "../src/index.ts";

const FROM = "App <noreply@example.com>";
const ctx = (env: Record<string, unknown> = {}) => ({ env }) as unknown as Context;
const attempt = (fn: () => unknown) => Promise.resolve().then(fn);

async function make(transport: MailTransport) {
  const plugin = mail({ transport, from: FROM });
  await miu({ logLevel: "silent", dev: false, plugins: [plugin] }).ready();
  const sections = plugin.manage!();
  expect(sections.map((s) => s.id)).toEqual(["mail"]);
  return { plugin, s: sections[0] };
}
const list = (s: ManageSection, name: string): ManageList => s.lists!.find((x) => x.name === name)!;
const action = (s: ManageSection, name: string): ManageAction => s.actions!.find((x) => x.name === name)!;
const stats = async (s: ManageSection) => Object.fromEntries((await s.status!(ctx())).stats!.map((x) => [x.label, x.value]));

/** A transport that fails for addresses at fail.example. */
function picky(): MailTransport & { sent: number } {
  const t = {
    kind: "picky",
    sent: 0,
    async send(m: { to: string[] }) {
      if (m.to.some((a) => a.endsWith("@fail.example"))) throw new Error("mailbox unavailable");
      t.sent++;
    },
  };
  return t;
}

describe("maskAddress", () => {
  test("keeps the first character and the domain; drops display names", () => {
    expect(maskAddress("ann@example.com")).toBe("a***@example.com");
    expect(maskAddress("Bob Smith <bob@example.com>")).toBe("b***@example.com");
    expect(maskAddress("x@y.co")).toBe("x***@y.co");
    expect(maskAddress("not an address")).toBe("***");
  });
});

describe("createMailer: counters and recent sends", () => {
  test("counts sent and failed sends and keeps the newest RECENT_SENDS", async () => {
    const m = createMailer({ transport: picky(), from: FROM });
    for (let i = 0; i < RECENT_SENDS + 5; i++) await m.send({ to: `u${i}@example.com`, subject: `n${i}`, text: "x" });
    await expect(m.send({ to: "z@fail.example", subject: "bad", text: "x" })).rejects.toMatchObject({ code: "MIU_E_MAIL_SEND_FAILED" });
    await expect(m.send({ to: "not-an-address", subject: "bad", text: "x" })).rejects.toMatchObject({ code: "MIU_E_MAIL_ADDRESS_INVALID" });
    expect(m.stats()).toEqual({ sent: RECENT_SENDS + 5, failed: 2 });
    const recent = m.recent();
    expect(recent).toHaveLength(RECENT_SENDS);
    expect(recent[0]).toMatchObject({ to: "***", status: "failed", code: "MIU_E_MAIL_ADDRESS_INVALID" });
    expect(recent[1]).toMatchObject({ to: "z***@fail.example", subject: "bad", status: "failed", code: "MIU_E_MAIL_SEND_FAILED" });
    expect(recent[2]).toMatchObject({ to: `u***@example.com`, subject: `n${RECENT_SENDS + 4}`, status: "sent", code: null });
    expect(recent.at(-1)!.subject).toBe("n7");
  });

  test("withEnv mailers share the counters", async () => {
    const m = createMailer({ transport: memoryTransport(), from: FROM });
    await m.withEnv({}).send({ to: "a@example.com", subject: "s", text: "t" });
    expect(m.stats()).toEqual({ sent: 1, failed: 0 });
  });

  test("codes and long tokens in subjects are hidden in the recent list", async () => {
    const m = createMailer({ transport: memoryTransport(), from: FROM });
    await m.send({ to: "a@example.com", subject: "Your code is 482913", text: "t" });
    await m.send({ to: "a@example.com", subject: "Reset: eyJhbGciOiJIUzI1NiJ9abcdefghijklmnop", text: "t" });
    await m.send({ to: "a@example.com", subject: "Invoice 2026 for Ann", text: "t" });
    expect(m.recent().map((r) => r.subject)).toEqual(["Invoice 2026 for Ann", "Reset: [hidden]", "Your code is [hidden]"]);
  });
});

describe("mail manage", () => {
  test("status shows transport kind and counters, never credentials", async () => {
    const t1 = await make(resendTransport({ apiKey: "re_live_SECRETKEY", fetch: (async () => Response.json({ id: "x" })) as unknown as typeof fetch }));
    await t1.plugin.manage!()[0].actions!.find((a) => a.name === "sendTest")!.run({ to: "ops@example.com" }, ctx());
    const st = await t1.s.status!(ctx());
    expect(Object.fromEntries(st.stats!.map((x) => [x.label, x.value]))).toMatchObject({ Transport: "resend", From: FROM, Sent: 1, Failed: 0, Templates: 0 });
    expect(JSON.stringify(st)).not.toContain("SECRETKEY");

    const t2 = await make(httpTransport({ url: "https://relay.example/send?api_key=SECRETQS", headers: { authorization: "Bearer SECRETHDR" }, map: (m) => m, fetch: (async () => new Response("{}")) as unknown as typeof fetch }));
    const st2 = JSON.stringify(await t2.s.status!(ctx()));
    expect(st2).not.toContain("SECRETQS");
    expect(st2).not.toContain("SECRETHDR");
    expect(st2).toContain('"http"');
  });

  test("failed counter is critical when sends fail", async () => {
    const { plugin, s } = await make(picky());
    await expect(attempt(() => action(s, "sendTest").run({ to: "x@fail.example" }, ctx()))).rejects.toMatchObject({ code: "MIU_E_MAIL_SEND_FAILED" });
    expect((await s.status!(ctx())).stats!.find((x) => x.label === "Failed")).toMatchObject({ value: 1, tone: "critical" });
    expect(plugin.name).toBe("mail");
  });

  test("sendTest validates the address and sends a short test email", async () => {
    const transport = memoryTransport();
    const { s } = await make(transport);
    const a = action(s, "sendTest");
    expect(validate(a.input!, {}).ok).toBe(false);
    expect(validate(a.input!, { to: "nope" }).ok).toBe(false);
    expect(validate(a.input!, { to: "Ann <ann@example.com>" }).ok).toBe(false);
    expect(validate(a.input!, { to: "ann@example.com" }).ok).toBe(true);
    const r = (await a.run({ to: "ann@example.com" }, ctx())) as { id: string; message: string };
    expect(r.message).toBe("Sent a test email to ann@example.com via memory.");
    expect(transport.outbox).toHaveLength(1);
    expect(transport.outbox[0]).toMatchObject({ to: ["ann@example.com"], from: FROM, subject: "Test email" });
    expect(transport.outbox[0].text).toContain("test");
  });

  test("recent list pages newest first and filters by status", async () => {
    const { s, plugin } = await make(picky());
    const send = action(s, "sendTest");
    for (const to of ["a@example.com", "b@fail.example", "c@example.com"]) await attempt(() => send.run({ to }, ctx())).catch(() => {});
    const recent = list(s, "recent");
    expect(recent.idKey).toBe("id");
    expect(recent.filters).toEqual([{ key: "status", label: "Status", options: ["sent", "failed"] }]);
    const p1 = await recent.list({ limit: 2 }, ctx());
    expect(p1.rows.map((r) => r.to)).toEqual(["c***@example.com", "b***@fail.example"]);
    expect(p1.rows[1]).toMatchObject({ status: "failed", code: "MIU_E_MAIL_SEND_FAILED", subject: "Test email" });
    expect(typeof p1.rows[0].at).toBe("string");
    const p2 = await recent.list({ limit: 2, cursor: p1.next }, ctx());
    expect(p2.rows.map((r) => r.to)).toEqual(["a***@example.com"]);
    expect(p2.next).toBeUndefined();
    expect((await recent.list({ limit: 10, filters: { status: "failed" } }, ctx())).rows.map((r) => r.to)).toEqual(["b***@fail.example"]);
    await expect(attempt(() => recent.list({ limit: 10, filters: { status: "bounced" } }, ctx()))).rejects.toThrow(/status/);
    await expect(attempt(() => recent.list({ limit: 10, cursor: "x1" }, ctx()))).rejects.toThrow(/cursor/);
    expect(JSON.stringify(await recent.list({ limit: 10 }, ctx()))).not.toContain("a@example.com");
    expect(plugin.name).toBe("mail");
  });

  test("before setup the section still answers", async () => {
    const plugin = mail({ transport: memoryTransport(), from: FROM });
    const s = plugin.manage!()[0];
    expect(await stats(s)).toMatchObject({ Transport: "memory", Sent: 0, Failed: 0 });
    expect((await list(s, "recent").list({ limit: 10 }, ctx())).rows).toEqual([]);
  });
});
