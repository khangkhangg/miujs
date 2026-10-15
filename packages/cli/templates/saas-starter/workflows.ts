// Durable workflows. `project.created` (emitted by POST /projects) starts `project-welcome`, which
// emails the creator. Steps are journaled: a crash or deploy mid-run resumes, not repeats.

import { t } from "miujs";
import { defineWorkflow, on } from "@miujs/workflows";

export const projectWelcome = defineWorkflow("project-welcome", {
  description: "Email the creator of a new project",
  trigger: on("project.created"),
  input: t.object({ projectId: t.string(), name: t.string(), email: t.nullable(t.string()) }),
  run: async ({ input, step, mailer, log }) => {
    const sent = await step.run("email", async () => {
      if (!input.email || !mailer) return false;
      await mailer.send({
        to: input.email,
        subject: `Your project ${input.name} is ready`,
        text: `Project "${input.name}" was created. Invite your team from the members page.`,
      });
      return true;
    });
    log.info("project welcome", { projectId: input.projectId, sent });
    return { sent };
  },
});

export const allWorkflows = [projectWelcome];
