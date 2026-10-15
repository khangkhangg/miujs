// mail().manage(): what an operator sees in @miujs/admin: the transport kind (never its
// credentials or URL), send counters, the recent sends with masked recipients, and a test email.
import { errors, t, type ManageSection, type ManageStat, type ManageValue } from "miujs";
import { RECENT_SENDS, type CreatedMailer, type MailTransport } from "./mailer.ts";

const PAGE_MAX = 100;
const STATUSES = ["sent", "failed"] as const;

export interface MailManageDeps {
  /** The mailer, once the plugin is set up. */
  mailer(): CreatedMailer | undefined;
  /** The configured transport, for the status before setup. */
  transport(): MailTransport | undefined;
  from: string;
  templates: number;
}

export function mailManage(d: MailManageDeps): ManageSection[] {
  return [
    {
      id: "mail",
      title: "Mail",
      description: "Outgoing email: the transport, send counters, recent sends and a test email.",
      status() {
        const m = d.mailer();
        const { sent, failed } = m?.stats() ?? { sent: 0, failed: 0 };
        const kind = (m?.transport ?? d.transport())?.kind ?? "console";
        const stats: ManageStat[] = [
          { label: "Transport", value: kind, hint: kind === "console" ? "Dev only: mail is logged, not delivered." : "Credentials are not shown." },
          { label: "From", value: d.from },
          { label: "Sent", value: sent, hint: "Since this instance started." },
          { label: "Failed", value: failed, hint: "Since this instance started. See Recent sends for error codes.", ...(failed > 0 ? { tone: "critical" as const } : {}) },
          { label: "Templates", value: d.templates },
        ];
        return { stats };
      },
      lists: [
        {
          name: "recent",
          title: "Recent sends",
          columns: [
            { key: "at", label: "Time", type: "date" },
            { key: "to", label: "To (masked)" },
            { key: "subject", label: "Subject" },
            { key: "status", label: "Status" },
            { key: "code", label: "Error", type: "code" },
            { key: "id", label: "Id", type: "code" },
          ],
          idKey: "id",
          filters: [{ key: "status", label: "Status", options: [...STATUSES] }],
          list(q) {
            const status = q.filters?.status;
            if (status && !(STATUSES as readonly string[]).includes(status)) throw errors.badRequest(`Unknown send status ${JSON.stringify(status)}`, `Filter by one of: ${STATUSES.join(", ")}.`);
            let offset = 0;
            if (q.cursor) {
              offset = /^\d{1,4}$/.test(q.cursor) ? Number(q.cursor) : NaN;
              if (!(offset <= RECENT_SENDS)) throw errors.badRequest(`Invalid cursor ${JSON.stringify(q.cursor)}`, "Pass the `next` value of the previous page, or no cursor for the first page.");
            }
            const limit = Math.max(1, Math.min(PAGE_MAX, Math.trunc(q.limit) || PAGE_MAX));
            const all = (d.mailer()?.recent() ?? []).filter((r) => !status || r.status === status);
            const rows: Record<string, ManageValue>[] = all.slice(offset, offset + limit).map((r) => ({ at: new Date(r.at).toISOString(), to: r.to, subject: r.subject, status: r.status, code: r.code, id: r.id }));
            return offset + limit < all.length ? { rows, next: String(offset + limit) } : { rows };
          },
        },
      ],
      actions: [
        {
          name: "sendTest",
          title: "Send a test email",
          description: "Send a short test email through the configured transport, to check delivery.",
          input: t.object({ to: t.string({ format: "email", maxLength: 254, description: "Recipient address" }) }),
          async run(input: { to: string }, ctx) {
            const m = d.mailer();
            if (!m) throw errors.badRequest("Mail is not set up yet", "Wait for the app to start (await app.ready()), then try again.");
            const r = await m.withEnv(ctx.env).send({
              to: input.to,
              subject: "Test email",
              text: "This is a test email sent from the admin to check that mail is delivered. No action is needed.",
            });
            return { id: r.id, message: `Sent a test email to ${input.to} via ${m.transport.kind}.` };
          },
        },
      ],
    },
  ];
}
