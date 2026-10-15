import { expect, test } from "bun:test";
import { richText } from "../src/richtext.ts";

test("paragraphs and line breaks", () => {
  expect(richText("one\ntwo\n\nthree")).toBe("<p>one<br>two</p><p>three</p>");
});

test("bold, emphasis and https links", () => {
  expect(richText("**Big** and *small* [docs](https://example.com/a?b=1&c=2)")).toBe(
    '<p><strong>Big</strong> and <em>small</em> <a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">docs</a></p>',
  );
});

test("markup in the text is escaped, never interpreted", () => {
  const out = richText('<img src=x onerror="alert(1)"> **<b>x</b>**');
  expect(out).not.toContain("<img");
  expect(out).not.toContain("<b>");
  expect(out).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
});

test("only http(s) links become anchors", () => {
  const out = richText("[click](javascript:alert(1)) [x](data:text/html,hi)");
  expect(out).not.toContain("<a");
  expect(out).toContain("[click](javascript:alert(1))");
});

test("link text and URLs cannot break out of the attribute", () => {
  const out = richText('[a"b](https://e.com/"onmouseover=x)');
  expect(out).not.toContain('"onmouseover');
});

test("empty text renders nothing", () => {
  expect(richText("")).toBe("");
  expect(richText("  \n\n ")).toBe("");
});

test("text around links is escaped too", () => {
  const out = richText("<b>before</b> [a](https://e.com) <i>after</i>");
  expect(out).toBe('<p>&lt;b&gt;before&lt;/b&gt; <a href="https://e.com" target="_blank" rel="noopener noreferrer">a</a> &lt;i&gt;after&lt;/i&gt;</p>');
});
