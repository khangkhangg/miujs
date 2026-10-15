// __APP_NAME__: a multi-tenant SaaS starter. Everything is wired:
//
//   db        one database for users, orgs, audit log, workflow runs and your tables
//   session   signed-cookie sessions + CSRF (SESSION_SECRET)
//   auth      /auth/register, /auth/login, /auth/logout, /auth/me, API tokens, password reset
//   access    orgs, members, invitations, roles → permissions (POST /orgs, /orgs/:orgId/invites)
//   mail      ctx.mail (console in dev, preview at /_miu/mail; Resend in production)
//   audit     tamper-evident log of changes and sign-ins (GET /audit, AUDIT_HMAC_KEY)
//   workflows durable background flows triggered by events (GET /workflows)
//
//   bun app.ts
//   curl -X POST localhost:3000/auth/register -H 'content-type: application/json' \
//        -d '{"email":"ann@example.com","password":"correct horse battery"}' -c jar
//   curl -X POST localhost:3000/orgs -b jar -H 'origin: http://localhost:3000' \
//        -H 'content-type: application/json' -d '{"name":"Acme"}'
//   curl -X POST localhost:3000/projects -b jar -H 'origin: http://localhost:3000' \
//        -H 'x-org-id: <id from above>' -H 'content-type: application/json' -d '{"name":"Apollo"}'

import { miu, processEnv, route, targetRuntime, type CallFn } from "miujs";
import { access, defineRoles } from "@miujs/access";
import { audit, dbAuditStore } from "@miujs/audit";
import { auth, dbUserStore } from "@miujs/auth";
import { db } from "@miujs/db";
import { consoleTransport, createMailer, mail, resendTransport, type MailMessage } from "@miujs/mail";
import { session } from "@miujs/session";
import { dbRunStore, workflows } from "@miujs/workflows";
import { database, migrations } from "./database.ts";
import * as projects from "./routes/projects.ts";
import { allWorkflows } from "./workflows.ts";

const env = processEnv();
const production = targetRuntime() === "workerd" || env.MIU_ENV === "production" || env.NODE_ENV === "production";

// Roles are per organization. "*" is every permission; access's own routes use members:*.
export const roles = defineRoles({
  owner: ["*"],
  admin: ["projects:read", "projects:write", "members:read", "members:invite", "members:manage", "audit:read", "workflows:read"],
  member: ["projects:read", "projects:write", "members:read"],
});

const FROM = "__APP_NAME__ <noreply@example.com>"; // TODO: a verified sender domain
const transport = production ? resendTransport() : consoleTransport(); // RESEND_API_KEY in production
// Workflows send through the same transport (their step mailer takes a plain message object).
const mailer = createMailer({ from: FROM, transport });

const health = {
  health: route.get("/health", { summary: "Check that the app is up", handler: () => ({ ok: true }) }),
  tests: {
    "health is ok": async (call: CallFn) => {
      (await call(health.health)).expectStatus(200);
    },
  },
};

const app = miu({
  name: "__APP_NAME__",
  routes: [health, projects],
  plugins: [
    db({ database, migrations }),
    session(),
    auth({ users: dbUserStore(database) }),
    access({ roles }),
    mail({ from: FROM, transport }),
    audit({ store: dbAuditStore(database), auth: true }),
    workflows({ workflows: allWorkflows, store: dbRunStore(database), mailer: { send: (msg) => mailer.send(msg as unknown as MailMessage) } }),
  ],
  mcp: true,
});

export default app;
