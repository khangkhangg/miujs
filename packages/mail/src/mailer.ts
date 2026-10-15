import { detectRuntime, errors, isMiuError, processEnv, type Env } from "miujs";
import { checkAddress, checkHeaders, checkSubject, htmlToText } from "./message.ts";
import { consoleTransport } from "./transports.ts";

/** What callers pass to `send`. Give `template` (+ `data`), or `subject` with `html` and/or `text`. */
export interface MailMessage {
  to: string | string[];
  subject?: string;
  html?: string;
  text?: string;
  /** Name of a template registered with `templates`. Its output fills fields the message leaves out. */
  template?: string;
  data?: unknown;
  replyTo?: string;
  /** Extra headers (e.g. `List-Unsubscribe`). Recipient/sender headers are refused. */
  headers?: Record<string, string>;
}

/** A validated, fully rendered message as transports receive it. `text` is always present. */
export interface OutgoingMail {
  id: string;
  from: string;
  to: string[];
  subject: string;
  html?: string;
  text: string;
  replyTo?: string;
  headers: Record<string, string>;
  createdAt: number;
}

export interface MailTransport {
  readonly kind: string;
  /** Deliver one message. Return the provider's id when it has one. */
  send(message: OutgoingMail, env: Env): Promise<{ id?: string } | void>;
  /** Recent messages, for the dev preview at `/_miu/mail`. */
  readonly outbox?: readonly OutgoingMail[];
  inspect?(): Record<string, unknown>;
}

export interface RenderedTemplate {
  subject: string;
  html?: string;
  text?: string;
}

export interface MailTemplate<D = any> {
  readonly name: string;
  render(data: D): RenderedTemplate;
}

/** A named email. Escape data you put in `html` with `escapeHtml`. */
export function defineTemplate<D = any>(name: string, render: (data: D) => RenderedTemplate): MailTemplate<D> {
  return { name, render };
}

export interface Mailer {
  send(message: MailMessage): Promise<{ id: string }>;
}

export interface MailerOptions {
  /** Where mail goes. Default in dev: `consoleTransport()`. Required in production. */
  transport?: MailTransport;
  /** Sender, e.g. `"Acme <noreply@acme.com>"`. */
  from: string;
  templates?: MailTemplate[] | Record<string, MailTemplate>;
  /** Env vars / bindings given to the transport (API keys). Default: the process environment. */
  env?: Env;
  /** Allow the console fallback. Default: on unless MIU_ENV/NODE_ENV is production or on Workers. */
  dev?: boolean;
}

export interface CreatedMailer extends Mailer {
  readonly transport: MailTransport;
  readonly from: string;
  readonly templateNames: string[];
  /** The same mailer with other env vars / bindings (used per request on Workers). */
  withEnv(env: Env): Mailer;
  /** Sends that succeeded or threw since this mailer was created (all `withEnv` copies included). */
  stats(): { sent: number; failed: number };
  /** The last `RECENT_SENDS` sends, newest first, with masked recipients and no bodies. */
  recent(): RecentSend[];
}

/** How many sends `recent()` keeps (a ring buffer: older ones are dropped). */
export const RECENT_SENDS = 200;

/** One send, as operators see it: no bodies, recipients masked, codes in subjects hidden. */
export interface RecentSend {
  id: string;
  /** Masked, e.g. "a***@example.com"; several recipients are joined with ", ". */
  to: string;
  subject: string | null;
  status: "sent" | "failed";
  /** MiuError code of a failure. */
  code: string | null;
  /** Epoch ms. */
  at: number;
}

/** "Ann <ann@example.com>" -> "a***@example.com". Anything that is not an address -> "***". */
export function maskAddress(address: string): string {
  const m = /<([^<>\s]+)>\s*$/.exec(address);
  const bare = (m ? m[1] : address).trim();
  const at = bare.lastIndexOf("@");
  if (at < 1 || at === bare.length - 1 || /\s/.test(bare)) return "***";
  return `${bare[0]}***${bare.slice(at)}`;
}

function maskRecipients(to: unknown): string {
  const list = (Array.isArray(to) ? to : [to]).map((a) => (typeof a === "string" ? maskAddress(a) : "***"));
  return list.length > 3 ? `${list.slice(0, 3).join(", ")} +${list.length - 3} more` : list.join(", ");
}

/** Hides one-time codes (6+ digits) and long tokens (24+ characters) that subjects sometimes carry. */
function maskSubject(subject: unknown): string | null {
  if (typeof subject !== "string") return null;
  const s = subject.replace(/\b\d{6,}\b/g, "[hidden]").replace(/[A-Za-z0-9_\-.~+/=]{24,}/g, "[hidden]");
  return s.length > 200 ? `${s.slice(0, 199)}…` : s;
}

export function defaultDev(): boolean {
  if (detectRuntime() === "workerd") return false;
  const env = processEnv();
  return (env.MIU_ENV ?? env.NODE_ENV) !== "production";
}

export const transportMissing = () =>
  errors.config(
    "MIU_E_MAIL_TRANSPORT_MISSING",
    "No mail transport configured in production",
    "Pass a transport: mail({ transport: resendTransport(), from }) (reads RESEND_API_KEY), or httpTransport({ url, map }) for another provider. consoleTransport() only logs.",
  );

function contentMissing(what: string) {
  return errors.custom({
    code: "MIU_E_MAIL_CONTENT_MISSING",
    status: 500,
    message: `Email has no ${what}`,
    fix: "Pass `subject` and `html` or `text`, or a `template` that returns them.",
  });
}

function newId(): string {
  return crypto.randomUUID();
}

/** A mailer for code outside requests (jobs, workflows, scripts). Inside requests use `ctx.mail`. */
export function createMailer(opts: MailerOptions): CreatedMailer {
  const transport = opts.transport ?? ((opts.dev ?? defaultDev()) ? consoleTransport() : undefined);
  if (!transport) throw transportMissing();
  const templates = new Map<string, MailTemplate>();
  for (const tpl of Array.isArray(opts.templates) ? opts.templates : Object.values(opts.templates ?? {})) templates.set(tpl.name, tpl);

  const counts = { sent: 0, failed: 0 };
  const recent: RecentSend[] = [];
  const remember = (r: RecentSend) => {
    recent.push(r);
    if (recent.length > RECENT_SENDS) recent.shift();
  };

  async function send(msg: MailMessage, env: Env): Promise<{ id: string }> {
    let subject: unknown = msg?.subject;
    try {
      const r = await deliver(msg, env, (s) => (subject = s));
      counts.sent++;
      remember({ id: r.id, to: maskRecipients(msg.to), subject: maskSubject(subject), status: "sent", code: null, at: Date.now() });
      return r;
    } catch (err) {
      counts.failed++;
      const code = (err as { code?: unknown } | null)?.code;
      remember({ id: newId(), to: maskRecipients(msg?.to), subject: maskSubject(subject), status: "failed", code: typeof code === "string" ? code : null, at: Date.now() });
      throw err;
    }
  }

  async function deliver(msg: MailMessage, env: Env, rendered: (subject: string) => void): Promise<{ id: string }> {
    const from = checkAddress(opts.from, "from");
    let { subject, html, text } = msg;
    if (msg.template !== undefined) {
      const tpl = templates.get(msg.template);
      if (!tpl) {
        const known = [...templates.keys()];
        throw errors.custom({
          code: "MIU_E_MAIL_TEMPLATE_UNKNOWN",
          status: 500,
          message: `No email template named ${JSON.stringify(msg.template)}`,
          fix: known.length ? `Use one of: ${known.join(", ")}; or register it in templates.` : "Register it with mail({ templates: [defineTemplate(name, render)] }).",
        });
      }
      const out = tpl.render(msg.data as never);
      subject ??= out.subject;
      html ??= out.html;
      text ??= out.text;
    }
    const toList = Array.isArray(msg.to) ? msg.to : [msg.to];
    if (toList.length === 0) throw errors.custom({ code: "MIU_E_MAIL_ADDRESS_INVALID", status: 400, message: "Email has no recipients", fix: "Pass at least one address in `to`." });
    const to = toList.map((a) => checkAddress(a, "to"));
    const replyTo = msg.replyTo === undefined ? undefined : checkAddress(msg.replyTo, "replyTo");
    if (typeof subject !== "string" || subject === "") throw contentMissing("subject");
    rendered(subject);
    checkSubject(subject);
    const headers = checkHeaders(msg.headers);
    if (!html && !text) throw contentMissing("body");
    const out: OutgoingMail = { id: newId(), from, to, subject, text: text ?? htmlToText(html!), headers, createdAt: Date.now() };
    if (html) out.html = html;
    if (replyTo) out.replyTo = replyTo;
    let result: { id?: string } | void;
    try {
      result = await transport!.send(out, env);
    } catch (err) {
      if (isMiuError(err)) throw err;
      throw errors.custom({
        code: "MIU_E_MAIL_SEND_FAILED",
        status: 502,
        message: `Sending email via ${transport!.kind} failed: ${err instanceof Error ? err.message : String(err)}`,
        fix: "Check the transport's credentials and the provider's status; the error above comes from the provider.",
        cause: err,
      });
    }
    return { id: (result && result.id) || out.id };
  }

  const baseEnv = opts.env;
  return {
    transport,
    from: opts.from,
    templateNames: [...templates.keys()],
    send: (msg) => send(msg, baseEnv ?? (processEnv() as Env)),
    withEnv: (env) => ({ send: (msg) => send(msg, env) }),
    stats: () => ({ ...counts }),
    recent: () => recent.slice().reverse(),
  };
}
