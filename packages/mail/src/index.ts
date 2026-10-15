// @miujs/mail — transactional email: `ctx.mail.send()`, templates, swappable transports and a dev
// outbox preview at /_miu/mail.

import { definePlugin, errors, route, t, type Context } from "miujs";
import { createMailer, transportMissing, type CreatedMailer, type Mailer, type MailerOptions, type MailTransport, type OutgoingMail } from "./mailer.ts";
import { checkAddress, escapeHtml } from "./message.ts";
import { consoleTransport } from "./transports.ts";

export { createMailer, defineTemplate, type CreatedMailer, type MailMessage, type MailTemplate, type Mailer, type MailerOptions, type MailTransport, type OutgoingMail, type RenderedTemplate } from "./mailer.ts";
export { escapeHtml, htmlToText } from "./message.ts";
export * from "./transports.ts";

declare module "miujs" {
  interface Context {
    /** Sends email. From `@miujs/mail`. */
    mail: Mailer;
  }
}

export type MailOptions = Omit<MailerOptions, "env" | "dev">;

const PREVIEW_CSP = "sandbox; default-src 'none'; script-src 'none'; img-src * data:; style-src 'unsafe-inline'; font-src * data:";

function previewRoutes(transport: MailTransport) {
  const outbox = () => transport.outbox ?? [];
  const list = route.get("/_miu/mail", {
    name: "_miu_mail_list",
    summary: "Dev only: list emails in the dev outbox",
    tags: ["internal", "mail"],
    mcp: false,
    handler: (ctx) => {
      const items = [...outbox()].reverse().map(({ id, to, subject, createdAt }) => ({ id, to, subject, createdAt }));
      if (!(ctx.headers.get("accept") ?? "").includes("text/html")) return { messages: items };
      const rows = items
        .map((m) => `<li><a href="/_miu/mail/${encodeURIComponent(m.id)}">${escapeHtml(m.subject)}</a> to ${escapeHtml(m.to.join(", "))} <small>${new Date(m.createdAt).toISOString()}</small></li>`)
        .join("");
      return new Response(`<!doctype html><meta charset="utf-8"><title>Dev outbox</title><h1>Dev outbox</h1><ul>${rows || "<li>No mail yet.</li>"}</ul>`, {
        headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": PREVIEW_CSP, "cache-control": "no-store" },
      });
    },
  });
  const one = route.get("/_miu/mail/:id", {
    name: "_miu_mail_show",
    summary: "Dev only: render one email from the dev outbox",
    tags: ["internal", "mail"],
    mcp: false,
    params: t.object({ id: t.string({ maxLength: 100 }) }),
    handler: (ctx) => {
      const m = outbox().find((x) => x.id === ctx.params.id);
      if (!m) throw errors.notFound("Email", ctx.params.id);
      const head =
        `<div style="font:13px system-ui;border-bottom:1px solid #ccc;padding:8px;margin-bottom:8px">` +
        `<div><b>From:</b> ${escapeHtml(m.from)}</div><div><b>To:</b> ${escapeHtml(m.to.join(", "))}</div>` +
        (m.replyTo ? `<div><b>Reply-To:</b> ${escapeHtml(m.replyTo)}</div>` : "") +
        `<div><b>Subject:</b> ${escapeHtml(m.subject)}</div></div>`;
      const body = m.html ?? `<pre style="white-space:pre-wrap">${escapeHtml(m.text)}</pre>`;
      return new Response(`<!doctype html><meta charset="utf-8"><title>${escapeHtml(m.subject)}</title>${head}${body}`, {
        headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": PREVIEW_CSP, "cache-control": "no-store" },
      });
    },
  });
  return [list, one];
}

/**
 * Adds `ctx.mail`.
 *
 * ```ts
 * miu({ plugins: [mail({ transport: resendTransport(), from: "Acme <noreply@acme.com>" })] })
 * ```
 *
 * In dev with no transport, mail is logged and shown at `/_miu/mail`.
 */
export function mail(opts: MailOptions) {
  let mailer: CreatedMailer | undefined;
  const describeTransport = () => opts.transport ?? mailer?.transport;
  return definePlugin({
    name: "mail",
    setup(app) {
      if (!opts.transport && !app.dev) throw transportMissing();
      checkAddress(opts.from, "from");
      mailer = createMailer({ ...opts, transport: opts.transport ?? consoleTransport(), dev: app.dev });
      // Jobs and workflows run outside requests: they reach the mailer through app.service("mail").
      app.provide("mail", mailer);
      if (app.dev && mailer.transport.outbox) app.add(previewRoutes(mailer.transport));
    },
    onRequest(ctx: Context) {
      ctx.mail = mailer!.withEnv(ctx.env);
    },
    inspect() {
      const transport = describeTransport();
      return {
        transport: transport?.kind ?? "console (dev default)",
        from: opts.from,
        templates: (Array.isArray(opts.templates) ? opts.templates : Object.values(opts.templates ?? {})).map((x) => x.name),
        ...(transport?.inspect ? { transportInfo: transport.inspect() } : {}),
        preview: transport?.outbox || !opts.transport ? "GET /_miu/mail (dev only)" : null,
      };
    },
  });
}

