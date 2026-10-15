/** @jsxImportSource @miujs/web */
import { describe, expect, test } from "bun:test";
import { html, isHtml, raw } from "../src/index.ts";
import { Fragment, jsx, jsxs } from "../src/jsx-runtime.ts";
import { jsxDEV } from "../src/jsx-dev-runtime.ts";

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    expect((e as any).fix).toBeTruthy();
    return (e as any).code;
  }
  return undefined;
}

const s = (x: unknown) => String(x);

describe("JSX via @jsxImportSource @miujs/web", () => {
  test("elements render to escaped HTML strings", () => {
    const name = "<b>&</b>";
    const el = <p class="greet">Hello {name}</p>;
    expect(isHtml(el)).toBe(true);
    expect(s(el)).toBe('<p class="greet">Hello &lt;b&gt;&amp;&lt;/b&gt;</p>');
  });

  test("attribute values are escaped", () => {
    const v = `"><script>x</script>`;
    expect(s(<a title={v} href="/x">y</a>)).toBe('<a title="&quot;&gt;&lt;script&gt;x&lt;/script&gt;" href="/x">y</a>');
  });

  test("components are functions receiving props and children", () => {
    const Card = (p: { title: string; children?: unknown }) => (
      <section>
        <h2>{p.title}</h2>
        {p.children}
      </section>
    );
    expect(s(<Card title="T&C"><p>body</p></Card>)).toBe("<section><h2>T&amp;C</h2><p>body</p></section>");
  });

  test("fragments, arrays, null/false/true/undefined children", () => {
    const items = ["a", "<b>"];
    const el = (
      <>
        <ul>{items.map((i) => <li>{i}</li>)}</ul>
        {null}
        {false}
        {true}
        {undefined}
        {0}
      </>
    );
    expect(s(el)).toBe("<ul><li>a</li><li>&lt;b&gt;</li></ul>0");
  });

  test("void elements self-close and reject children", () => {
    expect(s(<img src="/a.png" alt="" />)).toBe('<img src="/a.png" alt="">');
    expect(s(<br />)).toBe("<br>");
    expect(codeOf(() => jsx("input", { children: "x" }))).toBe("MIU_E_WEB_JSX_VOID_CHILDREN");
  });

  test("boolean attributes: true renders the name, false/null/undefined omit it", () => {
    expect(s(<input disabled checked={false} required={true} value={undefined} name={null as any} />)).toBe("<input disabled required>");
  });

  test("aria-* and data-* booleans render as strings", () => {
    expect(s(<div aria-hidden={false} data-open={true} />)).toBe('<div aria-hidden="false" data-open="true"></div>');
  });

  test("className and htmlFor map to class and for", () => {
    expect(s(<label className="c" htmlFor="x" />)).toBe('<label class="c" for="x"></label>');
  });

  test("style objects become CSS text, kebab-cased and escaped", () => {
    expect(s(<div style={{ backgroundColor: "red", "--tour-fov": 75, fontFamily: `"A"` }} />)).toBe(
      '<div style="background-color:red;--tour-fov:75;font-family:&quot;A&quot;"></div>',
    );
    expect(s(<div style="color:blue" />)).toBe('<div style="color:blue"></div>');
    expect(s(<div style={{ color: null, margin: 0 }} />)).toBe('<div style="margin:0"></div>');
  });

  test("dangerouslySetInnerHTML is the raw opt-out", () => {
    expect(s(<div dangerouslySetInnerHTML={{ __html: "<i>ok</i>" }} />)).toBe("<div><i>ok</i></div>");
    expect(codeOf(() => jsx("div", { dangerouslySetInnerHTML: { __html: "x" }, children: "y" }))).toBe("MIU_E_WEB_JSX_INNER_HTML");
    expect(codeOf(() => jsx("div", { dangerouslySetInnerHTML: "<x>" }))).toBe("MIU_E_WEB_JSX_INNER_HTML");
  });

  test("nested html`` and raw() are not escaped again; plain strings are", () => {
    expect(s(<div>{html`<b>${"<"}</b>`}{raw("<hr>")}{"<hr>"}</div>)).toBe("<div><b>&lt;</b><hr>&lt;hr&gt;</div>");
  });

  test("JSX inside html`` is not escaped again", () => {
    expect(s(html`<main>${<p>{"&"}</p>}</main>`)).toBe("<main><p>&amp;</p></main>");
  });

  test("on* attributes with string values are rejected", () => {
    expect(codeOf(() => jsx("button", { onclick: "alert(1)" }))).toBe("MIU_E_WEB_JSX_EVENT_HANDLER");
    expect(codeOf(() => jsx("button", { onClick: "alert(1)" }))).toBe("MIU_E_WEB_JSX_EVENT_HANDLER");
    expect(codeOf(() => jsx("button", { onClick: () => 1 }))).toBe("MIU_E_WEB_JSX_EVENT_HANDLER");
  });

  test("attribute names are validated", () => {
    expect(codeOf(() => jsx("div", { 'x"><script>': "1" }))).toBe("MIU_E_WEB_JSX_ATTR");
    expect(codeOf(() => jsx("div", { "a b": "1" }))).toBe("MIU_E_WEB_JSX_ATTR");
    expect(codeOf(() => jsx("div", { "a=b": "1" }))).toBe("MIU_E_WEB_JSX_ATTR");
    // htmx / Alpine / custom-element style names are fine.
    expect(s(jsx("div", { "hx-get": "/x", "x-on:click": "open = true", "@click": "n++", ":class": "c" }))).toBe(
      '<div hx-get="/x" x-on:click="open = true" @click="n++" :class="c"></div>',
    );
  });

  test("tag names are validated; custom elements are allowed", () => {
    expect(codeOf(() => jsx("di v", {}))).toBe("MIU_E_WEB_JSX_TAG");
    expect(codeOf(() => jsx("<script>", {}))).toBe("MIU_E_WEB_JSX_TAG");
    expect(s(<model-viewer src="/house.glb" camera-controls />)).toBe('<model-viewer src="/house.glb" camera-controls></model-viewer>');
  });

  test("key is ignored; functions and promises as children are errors", () => {
    expect(s(jsx("li", { children: "a" }, "k1"))).toBe("<li>a</li>");
    expect(codeOf(() => jsx("div", { children: () => 1 }))).toBe("MIU_E_WEB_HTML_FUNCTION");
    expect(codeOf(() => jsx("div", { children: Promise.resolve(1) }))).toBe("MIU_E_WEB_HTML_ASYNC");
  });

  test("jsxs, Fragment and jsxDEV behave like jsx", () => {
    expect(s(jsxs("p", { children: ["a", "<"] }))).toBe("<p>a&lt;</p>");
    expect(s(jsx(Fragment, { children: ["a", jsx("b", {})] }))).toBe("a<b></b>");
    expect(s(jsxDEV("i", { children: "x" }, undefined, false, undefined, undefined))).toBe("<i>x</i>");
  });
});
