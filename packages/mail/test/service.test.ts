import { expect, test } from "bun:test";
import { miu } from "miujs";
import { mail, memoryTransport } from "../src/index.ts";

test("mail() provides a `mail` service for jobs and workflows outside requests", async () => {
  const transport = memoryTransport();
  const app = miu({ logLevel: "silent", plugins: [mail({ transport, from: "Acme <noreply@acme.test>" })] });
  await app.ready();
  const mailer = app.service<{ send(m: { to: string; subject: string; text: string }): Promise<{ id: string }> }>("mail");
  await mailer.send({ to: "a@b.test", subject: "Hi", text: "Hello" });
  expect(transport.outbox.map((m) => m.to)).toEqual([["a@b.test"]]);
});
