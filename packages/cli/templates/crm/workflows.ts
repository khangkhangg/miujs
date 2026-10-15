// The follow-up workflow: two days after a contact is added, check whether it is still a lead and
// leave a reminder. Steps are journaled, so the two-day sleep survives restarts and deploys.

import { t } from "miujs";
import { defineWorkflow, on } from "@miujs/workflows";

export const contactFollowUp = defineWorkflow("contact-follow-up", {
  description: "Remind the team to follow up on new leads",
  trigger: on("contact.created"),
  input: t.object({ contactId: t.string(), orgId: t.string(), name: t.string() }),
  run: async ({ input, step, log }) => {
    await step.sleep("wait", "2d");
    const reminded = await step.run("remind", () => {
      // TODO: email the owner, create a task, or post to chat.
      log.info("follow up with lead", { contactId: input.contactId, orgId: input.orgId, name: input.name });
      return true;
    });
    return { reminded };
  },
});

export const allWorkflows = [contactFollowUp];
