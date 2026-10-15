import { expect, test } from "bun:test";
import { createMailer, mail, memoryTransport } from "../../mail/src/index.ts";
import { defineWorkflow, manual, workflows } from "../src/index.ts";
import { setup } from "./helpers.ts";

test("a @miujs/mail mailer type-checks as workflows({ mailer })", () => {
  const mailer = createMailer({ transport: memoryTransport(), from: "noreply@acme.test" });
  expect(() => workflows({ workflows: [], mailer })).not.toThrow();
});

test("without a mailer option, workflows use the mail plugin's service", async () => {
  const transport = memoryTransport();
  const wf = defineWorkflow("welcome", {
    trigger: manual(),
    run: async ({ step, mailer }: any) => {
      await step.run("send", () => mailer.send({ to: "new@user.test", subject: "Welcome", text: "Hi" }));
    },
  });
  const s = setup([wf], {}, { plugins: [mail({ transport, from: "noreply@acme.test" })] });
  await s.ready();
  await s.wf.start("welcome", {});
  await s.settle();
  expect(transport.outbox.length).toBe(1);
});
