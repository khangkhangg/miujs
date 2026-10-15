// Account-recovery and token findings from the 2026-10-16 audit.
import { expect, test } from "bun:test";
import { miu } from "miujs";
import { session } from "../../session/src/index.ts";
import { Jar, SECRET } from "../../session/test/helpers.ts";
import { auth, memoryUserStore } from "../src/index.ts";
import { SoftAuthenticator } from "./webauthn-fakes.ts";

const ORIGIN = "https://app.example";
const PW = { algorithm: "pbkdf2" as const, iterations: 1000 };

function setup() {
  const users = memoryUserStore();
  const mails: { to: string; text?: string; html?: string }[] = [];
  const app = miu({
    logLevel: "silent",
    plugins: [
      session({ secret: SECRET }),
      auth({ users, password: PW, mailer: { async send(m: any) { mails.push(m); } }, appUrl: ORIGIN, passkeys: { rpId: "app.example", rpName: "Ex", origins: [ORIGIN] } }),
    ],
  });
  const call = async (j: Jar | null, path: string, method: string, body?: unknown, headers: Record<string, string> = {}) => {
    const init = { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined };
    const res = await app.fetch(j ? j.request("http://localhost" + path, init) : new Request("http://localhost" + path, init));
    if (j) j.store(res);
    const t = await res.text();
    return { status: res.status, body: t ? JSON.parse(t) : null };
  };
  const resetLink = async (email: string) => {
    await call(new Jar(), "/auth/password/forgot", "POST", { email });
    await app.drain();
    const last = mails.at(-1);
    return last ? /token=([\w-]+)/.exec(JSON.stringify(last))?.[1] : undefined;
  };
  return { app, users, mails, call, resetLink };
}

test("an API token cannot mint new API tokens (revoking a leaked token must contain it)", async () => {
  const { call } = setup();
  const j = new Jar();
  await call(j, "/auth/register", "POST", { email: "v@example.com", password: "password-123" });
  const a = await call(j, "/auth/tokens", "POST", { name: "ci", expiresInDays: 1 });
  expect(a.status).toBe(201);
  const minted = await call(null, "/auth/tokens", "POST", { name: "persist", expiresInDays: 3650 }, { authorization: `Bearer ${a.body.token}` });
  expect(minted.status).toBe(403);
  expect(minted.body.error.code).toBe("MIU_E_AUTH_TOKEN_SESSION_REQUIRED");
  // The token itself still works for normal calls, and can still revoke itself.
  expect((await call(null, "/auth/me", "GET", undefined, { authorization: `Bearer ${a.body.token}` })).status).toBe(200);
});

test("a password reset removes passkeys an attacker may have added", async () => {
  const { call, resetLink } = setup();
  const victim = new Jar();
  await call(victim, "/auth/register", "POST", { email: "v@example.com", password: "password-123" });
  const attacker = new Jar();
  attacker.cookies = new Map(victim.cookies);
  const opts = await call(attacker, "/auth/passkeys/register/options", "POST", {});
  const authn = await new SoftAuthenticator(-7).init();
  expect((await call(attacker, "/auth/passkeys/register/verify", "POST", { credential: await authn.create(opts.body, ORIGIN) })).status).toBe(201);
  const token = await resetLink("v@example.com");
  expect((await call(new Jar(), "/auth/password/reset", "POST", { token, password: "brand-new-pass-456" })).status).toBe(200);
  const lj = new Jar();
  const lo = await call(lj, "/auth/passkeys/login/options", "POST", {});
  const lv = await call(lj, "/auth/passkeys/login/verify", "POST", { credential: await authn.get(lo.body, ORIGIN) });
  expect(lv.status).not.toBe(200);
  expect((await call(lj, "/auth/me", "GET")).status).toBe(401);
});

test("disabled accounts get no reset email, and a reset link cannot change their password", async () => {
  const { call, users, mails, resetLink } = setup();
  const j = new Jar();
  const reg = await call(j, "/auth/register", "POST", { email: "v@example.com", password: "password-123" });
  const before = await resetLink("v@example.com"); // issued while still enabled
  expect(before).toBeTruthy();
  await users.setUserDisabled!(reg.body.user.id, Date.now(), {} as any);
  const n = mails.length;
  await resetLink("v@example.com");
  expect(mails.length).toBe(n);
  const hash = (await users.findUserById(reg.body.user.id, {} as any))!.passwordHash;
  const r = await call(new Jar(), "/auth/password/reset", "POST", { token: before, password: "changed-by-disabled" });
  expect(r.status).toBe(400);
  expect((await users.findUserById(reg.body.user.id, {} as any))!.passwordHash).toBe(hash);
});
