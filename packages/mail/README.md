# @miujs/mail

> Transactional email for MiuJS: `ctx.mail.send()`, templates, Resend and generic HTTP transports, and a dev outbox preview at `/_miu/mail`.

`@miujs/mail` adds `ctx.mail` to every request and validates every message before it reaches a transport: addresses, header injection, and that there is a subject and a body. In development, with no transport, mail is logged and shown at `/_miu/mail`; in production a transport is required. Use `createMailer()` to send from jobs, workflows and scripts outside requests.

## Install

```bash
bun add @miujs/mail miujs
```

Bun runs the TypeScript source; Node and Deno get prebuilt JS with `.d.ts` types (npm packages are not published yet).

## Quick start

<!-- test -->
```ts
import { miu, route, t } from "miujs";
import { mail, resendTransport } from "@miujs/mail";

export const invite = route.post("/invites", {
  body: t.object({ email: t.string() }),
  handler: async (ctx) => {
    const { id } = await ctx.mail.send({ to: ctx.body.email, subject: "You are invited", html: "<p>Come join us.</p>" });
    return { id };
  },
});

export default miu({
  name: "app",
  routes: [invite],
  // resendTransport() reads RESEND_API_KEY from the env (a secret on Workers).
  plugins: [mail({ transport: resendTransport(), from: "Acme <noreply@acme.com>" })],
});
```

`send()` returns `{ id }`: the provider's message id when it returns one, otherwise a generated id. When only `html` is given, a plain-text version is derived with `htmlToText`.

## Messages

A message has `to` (one address or an array), `subject`, `html` and/or `text`, optional `replyTo` and extra `headers` (for example `List-Unsubscribe`). Addresses may be `ann@example.com` or `Ann <ann@example.com>`. Headers that name senders or recipients (`from`, `to`, `cc`, `bcc`, `reply-to`, ...) cannot be set through `headers`, and CR/LF in the subject or header values is refused.

## Templates

<!-- test -->
```ts
import { createMailer, defineTemplate, escapeHtml, memoryTransport } from "@miujs/mail";

const welcome = defineTemplate("welcome", (data: { name: string }) => ({
  subject: `Welcome, ${data.name}`,
  html: `<p>Hello ${escapeHtml(data.name)}</p>`,
}));

const transport = memoryTransport();
const mailer = createMailer({ transport, from: "App <noreply@example.com>", templates: [welcome] });

await mailer.send({ to: "a@example.com", template: "welcome", data: { name: "<Ann>" } });
console.log(transport.outbox[0].subject, transport.outbox[0].text);
```

Fields set on the message (`subject`, `html`, `text`) override the template's output. Escape data you put into `html` with `escapeHtml`. `templates` may be an array or an object of templates.

## Transports

- `resendTransport({ apiKey, apiKeyEnv, baseUrl, fetch })`: Resend over HTTP. Works on every runtime, including Workers.
- `httpTransport({ url, headers, map, id, fetch })`: any provider with a JSON HTTP API (Postmark, SendGrid, Mailgun, an internal relay).
- `consoleTransport({ log, keep })`: logs each message and keeps the last few for `/_miu/mail`. The dev default; never delivers.
- `memoryTransport()`: keeps every message in `.outbox`, with `clear()` and `waitFor(count, timeoutMs)`. For tests.

<!-- test -->
```ts
import { createMailer, httpTransport, type OutgoingMail } from "@miujs/mail";

const transport = httpTransport({
  url: "https://mail.example/send",
  headers: (env) => ({ "x-api-key": String(env.MAIL_KEY) }),
  map: (m: OutgoingMail) => ({ sender: m.from, recipients: m.to, title: m.subject, body: m.text, html: m.html }),
  id: (json) => (json as { messageId?: string } | null)?.messageId,
});

export const mailer = createMailer({ from: "App <noreply@example.com>", env: { MAIL_KEY: "k" }, transport });
```

A custom transport is an object with `kind` and `send(message, env)`; `send` may return `{ id }`. Errors that are not `MiuError`s become `MIU_E_MAIL_SEND_FAILED`.

## Testing

<!-- test -->
```ts
import { miu, route } from "miujs";
import { mail, memoryTransport } from "@miujs/mail";

const transport = memoryTransport();
const app = miu({
  logLevel: "silent",
  plugins: [mail({ transport, from: "App <noreply@example.com>" })],
  routes: [route.post("/invite", { handler: (ctx) => ctx.mail.send({ to: "guest@example.com", subject: "Invite", html: "<p>Come</p>" }) })],
});

await app.fetch(new Request("http://localhost/invite", { method: "POST" }));
const [sent] = await transport.waitFor(1);
console.log(sent.to, sent.subject);
```

## Options

`mail(options)` and `createMailer(options)`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `from` | `string` | required | Sender, e.g. `"Acme <noreply@acme.com>"`. |
| `transport` | `MailTransport` | `consoleTransport()` in dev; required in production | Where mail goes. |
| `templates` | `MailTemplate[] \| Record<string, MailTemplate>` | none | Named templates for `send({ template })`. |
| `env` | `Env` | process env (`createMailer` only; the plugin uses the request env) | Env vars / bindings given to the transport. |
| `dev` | `boolean` | on unless `MIU_ENV`/`NODE_ENV` is `production` or on Workers (`createMailer` only) | Allow the console fallback. |

`resendTransport(options)`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `apiKey` | `string` | `env[apiKeyEnv]` | Resend API key. |
| `apiKeyEnv` | `string` | `"RESEND_API_KEY"` | Env var / secret holding the key. |
| `baseUrl` | `string` | `"https://api.resend.com"` | API base URL. |
| `fetch` | `typeof fetch` | global `fetch` | Injectable for tests. |

`httpTransport(options)`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `url` | `string` | required | Endpoint that receives a JSON `POST`. |
| `map` | `(message) => unknown` | required | Turns the message into the provider's JSON body. |
| `headers` | `Record<string, string> \| (env) => Record<string, string>` | none | Static headers, or a function of env for API keys. |
| `id` | `(json) => string \| undefined` | none | Picks the provider's message id from the response. |
| `fetch` | `typeof fetch` | global `fetch` | Injectable for tests. |

`consoleTransport(options)`: `log` (default `console.log`), `keep` (default `50`).

## Admin (`manage()`)

With `@miujs/admin`, the plugin shows a **Mail** section:

- **Status**: transport kind (never its API key, URL or headers), sender, sends that succeeded and failed since this instance started, and the number of templates.
- **Recent sends**: the last 200 sends of this instance (a ring buffer), newest first, filterable by `sent` / `failed`. Recipients are masked (`a***@example.com`), bodies are never kept, and 6+ digit codes and long tokens in subjects show as `[hidden]`. Failures show their error code.
- **Action** `sendTest`: send a short test email to one address through the configured transport.

The counters and the list are also available in code: `createMailer(...).stats()` and `.recent()`.

## Errors

- `MIU_E_MAIL_TRANSPORT_MISSING`: no transport in production; fails at startup.
- `MIU_E_MAIL_ADDRESS_INVALID`: bad `from`, `to` or `replyTo`, or no recipients (400).
- `MIU_E_MAIL_HEADER_INVALID`: line break in the subject or a header, a reserved header, or a bad header name (400).
- `MIU_E_MAIL_CONTENT_MISSING`: no subject, or neither `html` nor `text`.
- `MIU_E_MAIL_TEMPLATE_UNKNOWN`: `template` names a template that was not registered.
- `MIU_E_MAIL_API_KEY_MISSING`: `resendTransport` found no API key.
- `MIU_E_MAIL_SEND_FAILED`: the provider rejected the message or the transport threw (502).

See [all error codes](../../docs/errors.md), e.g. [`MIU_E_MAIL_SEND_FAILED`](../../docs/errors.md#miu_e_mail_send_failed).

## Cloudflare Workers

No bindings are needed. `resendTransport` and `httpTransport` use `fetch` and read keys from the request env, so store them as secrets:

```bash
wrangler secret put RESEND_API_KEY
```

`createMailer()` never falls back to the console transport on Workers, so pass a transport there. The `mail()` plugin falls back only when the app runs in dev mode, and only then adds the `/_miu/mail` outbox routes.

## Links

- [Getting started guide](../../docs/guide.md)
- [Error codes](../../docs/errors.md)
- [AGENTS.md](../../AGENTS.md)
- [Source](./src)
- [Tests](./test)
- Related: [@miujs/workflows](../workflows/README.md), [@miujs/files](../files/README.md)
