import { describe, expect, test } from "bun:test";
import { escapeHtml, html, isHtml, raw, render } from "../src/index.ts";

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    expect((e as any).fix).toBeTruthy();
    return (e as any).code;
  }
  return undefined;
}

describe("html tagged template", () => {
  test("escapes interpolated strings", () => {
    const name = `<script>alert("x")</script>&'`;
    expect(String(html`<p>${name}</p>`)).toBe("<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;</p>");
  });

  test("keeps the literal parts as written", () => {
    expect(String(html`<a href="/x">ok</a>`)).toBe('<a href="/x">ok</a>');
  });

  test("numbers render; null, undefined, false and true render nothing", () => {
    expect(String(html`${1}|${0}|${null}|${undefined}|${false}|${true}`)).toBe("1|0||||");
  });

  test("arrays are joined without separators and each item is escaped", () => {
    const items = ["<a>", "b"];
    expect(String(html`<ul>${items.map((i) => html`<li>${i}</li>`)}</ul>`)).toBe("<ul><li>&lt;a&gt;</li><li>b</li></ul>");
    expect(String(html`${["<", [">", null]]}`)).toBe("&lt;&gt;");
  });

  test("nested html results are not double-escaped", () => {
    const inner = html`<b>${"&"}</b>`;
    expect(String(html`<div>${inner}</div>`)).toBe("<div><b>&amp;</b></div>");
  });

  test("raw() opts out of escaping", () => {
    expect(String(html`<div>${raw("<i>trusted</i>")}</div>`)).toBe("<div><i>trusted</i></div>");
  });

  test("components are plain functions", () => {
    const Layout = (title: string, body: unknown) => html`<title>${title}</title><main>${body}</main>`;
    expect(String(Layout("A & B", html`<h1>Hi</h1>`))).toBe("<title>A &amp; B</title><main><h1>Hi</h1></main>");
  });

  test("isHtml recognizes html results and raw()", () => {
    expect(isHtml(html``)).toBe(true);
    expect(isHtml(raw("x"))).toBe(true);
    expect(isHtml("x")).toBe(false);
    expect(isHtml({ value: "x" })).toBe(false);
  });

  test("escapeHtml escapes the five special characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
    expect(escapeHtml("plain")).toBe("plain");
  });

  test("interpolating a promise is an error with a fix", () => {
    expect(codeOf(() => html`${Promise.resolve("x")}`)).toBe("MIU_E_WEB_HTML_ASYNC");
  });

  test("interpolating a function is an error with a fix", () => {
    expect(codeOf(() => html`${() => "x"}`)).toBe("MIU_E_WEB_HTML_FUNCTION");
  });

  test("raw() requires a string", () => {
    expect(codeOf(() => raw(42 as any))).toBe("MIU_E_WEB_HTML_RAW");
  });
});

describe("render", () => {
  test("returns a text/html response", async () => {
    const res = render(html`<p>${"<x>"}</p>`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toBe("<p>&lt;x&gt;</p>");
  });

  test("accepts status and headers", async () => {
    const res = render(html`nope`, { status: 404, headers: { "x-a": "1" } });
    expect(res.status).toBe(404);
    expect(res.headers.get("x-a")).toBe("1");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  test("a plain string is escaped, never trusted", async () => {
    expect(await render("<b>" as any).text()).toBe("&lt;b&gt;");
  });

  test("works as a route handler result", async () => {
    const { miu, route } = await import("miujs");
    const page = route.get("/", { handler: () => render(html`<h1>${"Hi"}</h1>`) });
    const app = miu({ routes: [page], logLevel: "silent" });
    const res = await app.request("/");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toBe("<h1>Hi</h1>");
  });
});
