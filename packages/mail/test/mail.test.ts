import { describe, expect, test } from "bun:test";
import { miu, route } from "miujs";
import {
  consoleTransport,
  createMailer,
  defineTemplate,
  escapeHtml,
  htmlToText,
  httpTransport,
  mail,
  memoryTransport,
  resendTransport,
  type OutgoingMail,
} from "../src/index.ts";

const FROM = "App <noreply@example.com>";

describe("createMailer: send", () => {
  test("sends through the transport and returns an id", async () => {
    const transport = memoryTransport();
    const mailer = createMailer({ transport, from: FROM });
    const r = await mailer.send({ to: "ann@example.com", subject: "Hi", text: "Hello" });
    expect(typeof r.id).toBe("string");
    expect(r.id.length).toBeGreaterThan(8);
    expect(transport.outbox).toHaveLength(1);
    const m = transport.outbox[0];
    expect(m).toMatchObject({ id: r.id, from: FROM, to: ["ann@example.com"], subject: "Hi", text: "Hello" });
    expect(typeof m.createdAt).toBe("number");
  });

  test("accepts a list of recipients and Name <addr> forms", async () => {
    const transport = memoryTransport();
    await createMailer({ transport, from: FROM }).send({ to: ["a@example.com", "Bob <b@example.com>"], subject: "x", text: "y", replyTo: "help@example.com" });
    expect(transport.outbox[0].to).toEqual(["a@example.com", "Bob <b@example.com>"]);
    expect(transport.outbox[0].replyTo).toBe("help@example.com");
  });

  test("derives text from html when text is missing", async () => {
    const transport = memoryTransport();
    await createMailer({ transport, from: FROM }).send({ to: "a@example.com", subject: "x", html: "<p>Hello <b>Ann</b></p><p>Bye</p>" });
    expect(transport.outbox[0].text).toBe("Hello Ann\n\nBye");
    expect(transport.outbox[0].html).toBe("<p>Hello <b>Ann</b></p><p>Bye</p>");
  });

  test("a provider id is returned when the transport gives one", async () => {
    const mailer = createMailer({ from: FROM, transport: { kind: "fake", send: async () => ({ id: "prov-123" }) } });
    expect((await mailer.send({ to: "a@example.com", subject: "x", text: "y" })).id).toBe("prov-123");
  });

  for (const bad of ["not-an-email", "a@b", "<a@b.co", "a b@example.com", "", "a@example.com, b@example.com"]) {
    test(`rejects invalid recipient ${JSON.stringify(bad)}`, async () => {
      const transport = memoryTransport();
      const p = createMailer({ transport, from: FROM }).send({ to: bad, subject: "x", text: "y" });
      await expect(p).rejects.toMatchObject({ code: "MIU_E_MAIL_ADDRESS_INVALID" });
      expect(transport.outbox).toHaveLength(0);
    });
  }

  test("rejects an empty recipient list", async () => {
    await expect(createMailer({ transport: memoryTransport(), from: FROM }).send({ to: [], subject: "x", text: "y" })).rejects.toMatchObject({ code: "MIU_E_MAIL_ADDRESS_INVALID" });
  });

  test("rejects an invalid from or replyTo", async () => {
    await expect(createMailer({ transport: memoryTransport(), from: "nope" }).send({ to: "a@example.com", subject: "x", text: "y" })).rejects.toMatchObject({ code: "MIU_E_MAIL_ADDRESS_INVALID" });
    await expect(createMailer({ transport: memoryTransport(), from: FROM }).send({ to: "a@example.com", subject: "x", text: "y", replyTo: "bad" })).rejects.toMatchObject({ code: "MIU_E_MAIL_ADDRESS_INVALID" });
  });

  describe("header injection", () => {
    const cases: [string, Record<string, unknown>][] = [
      ["CRLF in subject", { subject: "Hi\r\nBcc: victim@example.com" }],
      ["LF in subject", { subject: "Hi\nBcc: victim@example.com" }],
      ["CR in subject", { subject: "Hi\rX" }],
      ["CRLF in to", { to: "a@example.com\r\nBcc: v@example.com" }],
      ["trailing CRLF in to", { to: "a@example.com\r\n" }],
      ["CRLF in a display name", { to: "Ann\r\nBcc: v@example.com <a@example.com>" }],
      ["LF in replyTo", { replyTo: "a@example.com\nBcc: v@example.com" }],
      ["CRLF in header value", { headers: { "X-Tag": "a\r\nBcc: v@example.com" } }],
      ["CRLF in header name", { headers: { "X-Tag\r\nBcc": "v@example.com" } }],
      ["colon in header name", { headers: { "X-Tag: y": "v" } }],
      ["Bcc via headers", { headers: { Bcc: "v@example.com" } }],
      ["To via headers (any case)", { headers: { tO: "v@example.com" } }],
      ["From via headers", { headers: { From: "ceo@example.com" } }],
    ];
    for (const [label, patch] of cases) {
      test(`rejects ${label}`, async () => {
        const transport = memoryTransport();
        const p = createMailer({ transport, from: FROM }).send({ to: "a@example.com", subject: "ok", text: "y", ...patch } as never);
        const err = await p.catch((e) => e);
        expect(["MIU_E_MAIL_HEADER_INVALID", "MIU_E_MAIL_ADDRESS_INVALID"]).toContain(err.code);
        expect(err.fix).toBeTruthy();
        expect(transport.outbox).toHaveLength(0);
      });
    }

    test("allows ordinary custom headers", async () => {
      const transport = memoryTransport();
      await createMailer({ transport, from: FROM }).send({ to: "a@example.com", subject: "ok", text: "y", headers: { "X-Entity-Ref": "abc-123", "List-Unsubscribe": "<https://example.com/u>" } });
      expect(transport.outbox[0].headers).toEqual({ "X-Entity-Ref": "abc-123", "List-Unsubscribe": "<https://example.com/u>" });
    });
  });

  test("rejects a message with no subject", async () => {
    await expect(createMailer({ transport: memoryTransport(), from: FROM }).send({ to: "a@example.com", text: "y" })).rejects.toMatchObject({ code: "MIU_E_MAIL_CONTENT_MISSING" });
  });

  test("rejects a message with no body", async () => {
    await expect(createMailer({ transport: memoryTransport(), from: FROM }).send({ to: "a@example.com", subject: "x" })).rejects.toMatchObject({ code: "MIU_E_MAIL_CONTENT_MISSING" });
  });

  test("transport failures become MIU_E_MAIL_SEND_FAILED", async () => {
    const mailer = createMailer({
      from: FROM,
      transport: {
        kind: "broken",
        send: async () => {
          throw new Error("boom");
        },
      },
    });
    const err = await mailer.send({ to: "a@example.com", subject: "x", text: "y" }).catch((e) => e);
    expect(err.code).toBe("MIU_E_MAIL_SEND_FAILED");
    expect(err.fix).toBeTruthy();
  });

  test("no transport in production is a config error with a fix", () => {
    let err: any;
    try {
      createMailer({ from: FROM, dev: false });
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe("MIU_E_MAIL_TRANSPORT_MISSING");
    expect(err.fix).toContain("resendTransport");
  });

  test("no transport in dev falls back to the console transport", async () => {
    const mailer = createMailer({ from: FROM, dev: true, transport: undefined });
    expect(mailer.transport.kind).toBe("console");
  });
});

describe("templates", () => {
  const welcome = defineTemplate("welcome", (data: { name: string }) => ({
    subject: `Welcome, ${data.name}`,
    html: `<p>Hello ${escapeHtml(data.name)}</p>`,
  }));

  test("renders a template by name with data; text is derived", async () => {
    const transport = memoryTransport();
    await createMailer({ transport, from: FROM, templates: [welcome] }).send({ to: "a@example.com", template: "welcome", data: { name: "<Ann>" } });
    const m = transport.outbox[0];
    expect(m.subject).toBe("Welcome, <Ann>");
    expect(m.html).toBe("<p>Hello &lt;Ann&gt;</p>");
    expect(m.text).toBe("Hello <Ann>");
  });

  test("templates can be passed as a record; message fields override the template", async () => {
    const transport = memoryTransport();
    await createMailer({ transport, from: FROM, templates: { welcome } }).send({ to: "a@example.com", template: "welcome", data: { name: "Ann" }, subject: "Custom" });
    expect(transport.outbox[0].subject).toBe("Custom");
  });

  test("unknown template → MIU_E_MAIL_TEMPLATE_UNKNOWN listing the known ones", async () => {
    const err = await createMailer({ transport: memoryTransport(), from: FROM, templates: [welcome] })
      .send({ to: "a@example.com", template: "welcom" })
      .catch((e) => e);
    expect(err.code).toBe("MIU_E_MAIL_TEMPLATE_UNKNOWN");
    expect(err.fix).toContain("welcome");
  });

  test("a template subject is still checked for header injection", async () => {
    const evil = defineTemplate("evil", (d: { s: string }) => ({ subject: d.s, text: "x" }));
    const err = await createMailer({ transport: memoryTransport(), from: FROM, templates: [evil] })
      .send({ to: "a@example.com", template: "evil", data: { s: "a\r\nBcc: v@example.com" } })
      .catch((e) => e);
    expect(err.code).toBe("MIU_E_MAIL_HEADER_INVALID");
  });

  test("escapeHtml escapes the five special characters", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe("&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
    expect(escapeHtml(42 as unknown as string)).toBe("42");
  });

  test("htmlToText strips tags, drops style/script, keeps link targets, decodes entities", () => {
    expect(htmlToText(`<style>p{color:red}</style><script>alert(1)</script><h1>Title</h1><p>Click <a href="https://x.example/v?t=1&amp;u=2">here</a></p>line<br>two &lt;3 &amp; &quot;q&quot; &#39;s&#39;`)).toBe(
      'Title\n\nClick here (https://x.example/v?t=1&u=2)\n\nline\ntwo <3 & "q" \'s\'',
    );
  });
});

describe("transports", () => {
  test("memoryTransport keeps an outbox and can be cleared", async () => {
    const t = memoryTransport();
    const m = createMailer({ transport: t, from: FROM });
    await m.send({ to: "a@example.com", subject: "1", text: "x" });
    await m.send({ to: "a@example.com", subject: "2", text: "x" });
    expect(t.outbox.map((x) => x.subject)).toEqual(["1", "2"]);
    t.clear();
    expect(t.outbox).toHaveLength(0);
  });

  test("memoryTransport.waitFor resolves once enough mail arrived", async () => {
    const t = memoryTransport();
    const m = createMailer({ transport: t, from: FROM });
    const waiting = t.waitFor(2);
    void m.send({ to: "a@example.com", subject: "1", text: "x" });
    setTimeout(() => void m.send({ to: "a@example.com", subject: "2", text: "x" }), 5);
    expect((await waiting).map((x) => x.subject)).toEqual(["1", "2"]);
  });

  test("memoryTransport.waitFor rejects after the timeout", async () => {
    await expect(memoryTransport().waitFor(1, 20)).rejects.toThrow(/1 message/);
  });

  test("consoleTransport logs a summary and keeps a bounded outbox", async () => {
    const lines: string[] = [];
    const t = consoleTransport({ log: (s) => lines.push(s), keep: 2 });
    const m = createMailer({ transport: t, from: FROM });
    for (const s of ["1", "2", "3"]) await m.send({ to: "a@example.com", subject: s, text: `body ${s}` });
    expect(t.outbox.map((x) => x.subject)).toEqual(["2", "3"]);
    expect(lines.join("\n")).toContain("a@example.com");
    expect(lines.join("\n")).toContain("body 3");
  });

  describe("resendTransport", () => {
    function fakeFetch(status = 200, body: unknown = { id: "re_123" }) {
      const calls: { url: string; init: RequestInit }[] = [];
      const f = (async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), init });
        return Response.json(body, { status });
      }) as unknown as typeof fetch;
      return { f, calls };
    }

    test("POSTs the message to the Resend API with the key", async () => {
      const { f, calls } = fakeFetch();
      const mailer = createMailer({ from: FROM, transport: resendTransport({ apiKey: "re_secret", fetch: f }) });
      const r = await mailer.send({ to: "a@example.com", subject: "Hi", html: "<p>x</p>", replyTo: "r@example.com", headers: { "X-Ref": "1" } });
      expect(r.id).toBe("re_123");
      expect(calls[0].url).toBe("https://api.resend.com/emails");
      expect(new Headers(calls[0].init.headers).get("authorization")).toBe("Bearer re_secret");
      const body = JSON.parse(calls[0].init.body as string);
      expect(body).toEqual({ from: FROM, to: ["a@example.com"], subject: "Hi", html: "<p>x</p>", text: "x", reply_to: "r@example.com", headers: { "X-Ref": "1" } });
    });

    test("reads the key from env (default RESEND_API_KEY, or a custom name)", async () => {
      const { f, calls } = fakeFetch();
      await createMailer({ from: FROM, env: { RESEND_API_KEY: "k1" }, transport: resendTransport({ fetch: f }) }).send({ to: "a@example.com", subject: "x", text: "y" });
      await createMailer({ from: FROM, env: { MY_KEY: "k2" }, transport: resendTransport({ apiKeyEnv: "MY_KEY", fetch: f }) }).send({ to: "a@example.com", subject: "x", text: "y" });
      expect(calls.map((c) => new Headers(c.init.headers).get("authorization"))).toEqual(["Bearer k1", "Bearer k2"]);
    });

    test("a missing key is a config error with a fix", async () => {
      const { f } = fakeFetch();
      const err = await createMailer({ from: FROM, env: {}, transport: resendTransport({ fetch: f }) })
        .send({ to: "a@example.com", subject: "x", text: "y" })
        .catch((e) => e);
      expect(err.code).toBe("MIU_E_MAIL_API_KEY_MISSING");
      expect(err.fix).toContain("RESEND_API_KEY");
    });

    test("a provider error becomes MIU_E_MAIL_SEND_FAILED without leaking the key", async () => {
      const { f } = fakeFetch(422, { message: "invalid from" });
      const err = await createMailer({ from: FROM, transport: resendTransport({ apiKey: "re_secret", fetch: f }) })
        .send({ to: "a@example.com", subject: "x", text: "y" })
        .catch((e) => e);
      expect(err.code).toBe("MIU_E_MAIL_SEND_FAILED");
      expect(err.message).toContain("422");
      expect(JSON.stringify(err.toJSON())).not.toContain("re_secret");
    });

    test("inspect() never shows the key", () => {
      expect(JSON.stringify(resendTransport({ apiKey: "re_secret" }).inspect?.())).not.toContain("re_secret");
    });
  });

  test("httpTransport maps the message and posts it", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => (calls.push({ url: String(url), init }), Response.json({ messageId: "p-9" }))) as unknown as typeof fetch;
    const transport = httpTransport({
      url: "https://mail.example/send",
      headers: (env) => ({ "x-api-key": String(env.KEY) }),
      map: (m: OutgoingMail) => ({ sender: m.from, recipients: m.to, title: m.subject, body: m.text }),
      id: (json: any) => json.messageId,
      fetch: f,
    });
    const r = await createMailer({ from: FROM, env: { KEY: "k" }, transport }).send({ to: "a@example.com", subject: "S", text: "T" });
    expect(r.id).toBe("p-9");
    expect(calls[0].url).toBe("https://mail.example/send");
    expect(new Headers(calls[0].init.headers).get("x-api-key")).toBe("k");
    expect(new Headers(calls[0].init.headers).get("content-type")).toContain("application/json");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ sender: FROM, recipients: ["a@example.com"], title: "S", body: "T" });
  });

  test("httpTransport: non-2xx is a send failure", async () => {
    const f = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const transport = httpTransport({ url: "https://mail.example/send", map: (m) => m, fetch: f });
    await expect(createMailer({ from: FROM, transport }).send({ to: "a@example.com", subject: "S", text: "T" })).rejects.toMatchObject({ code: "MIU_E_MAIL_SEND_FAILED" });
  });
});

describe("mail() plugin", () => {
  function makeApp(opts: Partial<Parameters<typeof mail>[0]> = {}, dev = true) {
    const transport = memoryTransport();
    const app = miu({
      logLevel: "silent",
      dev,
      mcp: true,
      plugins: [mail({ transport, from: FROM, ...opts })],
      routes: [
        route.post("/invite", {
          handler: async (ctx) => ctx.mail.send({ to: "guest@example.com", subject: "Invite", html: "<p>Come</p>" }),
        }),
      ],
    });
    return { app, transport };
  }

  test("decorates ctx.mail", async () => {
    const { app, transport } = makeApp();
    const res = await app.fetch(new Request("http://localhost/invite", { method: "POST" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(transport.outbox[0].id);
  });

  test("ctx.mail sees per-request env (Workers bindings)", async () => {
    const calls: string[] = [];
    const f = (async (_u: string, init: RequestInit) => (calls.push(new Headers(init.headers).get("authorization")!), Response.json({ id: "x" }))) as unknown as typeof fetch;
    const app = miu({
      logLevel: "silent",
      plugins: [mail({ transport: resendTransport({ fetch: f }), from: FROM })],
      routes: [route.post("/go", { handler: (ctx) => ctx.mail.send({ to: "a@example.com", subject: "x", text: "y" }) })],
    });
    await app.ready();
    const res = await app.dispatch(new Request("http://localhost/go", { method: "POST" }), { RESEND_API_KEY: "from-binding" }, { runtime: "workerd" });
    expect(res.status).toBe(200);
    expect(calls).toEqual(["Bearer from-binding"]);
  });

  test("production without a transport fails at startup with a fix", async () => {
    const app = miu({ logLevel: "silent", dev: false, plugins: [mail({ from: FROM })] });
    await expect(app.ready()).rejects.toMatchObject({ code: "MIU_E_MAIL_TRANSPORT_MISSING" });
  });

  test("dev without a transport uses the console transport", async () => {
    const app = miu({ logLevel: "silent", dev: true, plugins: [mail({ from: FROM, transport: consoleTransport({ log: () => {} }) })] });
    await app.ready();
    expect((app.inspect().plugins.find((p) => p.name === "mail")!.info as any).transport).toBe("console");
  });

  test("an invalid from is a startup error", async () => {
    const app = miu({ logLevel: "silent", plugins: [mail({ from: "nope", transport: memoryTransport() })] });
    await expect(app.ready()).rejects.toMatchObject({ code: "MIU_E_MAIL_ADDRESS_INVALID" });
  });

  test("inspect() shows transport, from and templates", () => {
    const tpl = defineTemplate("hello", () => ({ subject: "s", text: "t" }));
    const info = mail({ transport: memoryTransport(), from: FROM, templates: [tpl] }).inspect();
    expect(info).toMatchObject({ transport: "memory", from: FROM, templates: ["hello"] });
  });

  describe("dev preview", () => {
    test("GET /_miu/mail lists the outbox (JSON) and /_miu/mail/:id renders one", async () => {
      const { app } = makeApp();
      await app.fetch(new Request("http://localhost/invite", { method: "POST" }));
      const list = await app.fetch(new Request("http://localhost/_miu/mail"));
      expect(list.status).toBe(200);
      const body = await list.json();
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0]).toMatchObject({ to: ["guest@example.com"], subject: "Invite" });
      const one = await app.fetch(new Request(`http://localhost/_miu/mail/${body.messages[0].id}`));
      expect(one.status).toBe(200);
      expect(one.headers.get("content-type")).toContain("text/html");
      expect(await one.text()).toContain("<p>Come</p>");
    });

    test("the rendered message is sandboxed by CSP", async () => {
      const { app } = makeApp();
      await app.fetch(new Request("http://localhost/invite", { method: "POST" }));
      const { messages } = await (await app.fetch(new Request("http://localhost/_miu/mail"))).json();
      const one = await app.fetch(new Request(`http://localhost/_miu/mail/${messages[0].id}`));
      expect(one.headers.get("content-security-policy")).toContain("sandbox");
      expect(one.headers.get("content-security-policy")).toContain("script-src 'none'");
    });

    test("the list renders as HTML for browsers, escaping subjects", async () => {
      const transport = memoryTransport();
      const app = miu({ logLevel: "silent", dev: true, plugins: [mail({ transport, from: FROM })] });
      await createMailer({ transport, from: FROM }).send({ to: "a@example.com", subject: "<script>x</script>", text: "t" });
      const res = await app.fetch(new Request("http://localhost/_miu/mail", { headers: { accept: "text/html" } }));
      const html = await res.text();
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
      expect(html).not.toContain("<script>x");
    });

    test("unknown id → 404", async () => {
      const { app } = makeApp();
      expect((await app.fetch(new Request("http://localhost/_miu/mail/nope"))).status).toBe(404);
    });

    test("preview routes do not exist in production and are not MCP tools", async () => {
      const { app } = makeApp({}, false);
      expect((await app.fetch(new Request("http://localhost/_miu/mail"))).status).toBe(404);
      const dev = makeApp().app;
      await dev.ready();
      expect(dev.inspect().mcp!.tools.some((t) => t.includes("mail"))).toBe(false);
    });

    test("no preview when the transport keeps no outbox", async () => {
      const app = miu({ logLevel: "silent", dev: true, plugins: [mail({ from: FROM, transport: { kind: "x", send: async () => {} } })] });
      expect((await app.fetch(new Request("http://localhost/_miu/mail"))).status).toBe(404);
    });
  });
});
