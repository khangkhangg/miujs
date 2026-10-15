import { describe, expect, test } from "bun:test";
import { sanitizeHtml } from "../src/sanitize.ts";

describe("sanitizeHtml: keeps safe markup", () => {
  test("allowlisted tags pass through", () => {
    const html = "<p>Hello <strong>bold</strong> <em>it</em> <u>u</u> <s>s</s><br></p><ul><li>a</li></ul><ol><li>b</li></ol><blockquote>q</blockquote><pre><code>x</code></pre><h2>T</h2><hr>";
    expect(sanitizeHtml(html)).toBe(html);
  });

  test("text is escaped and entities kept", () => {
    expect(sanitizeHtml("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
    expect(sanitizeHtml("Tom &amp; Jerry &copy; &#169; &#xA9;")).toBe("Tom &amp; Jerry &copy; &#169; &#xA9;");
  });

  test("safe links keep href and title; rel is forced", () => {
    expect(sanitizeHtml('<a href="https://ex.com/?a=1&amp;b=2" title="t">x</a>')).toBe('<a href="https://ex.com/?a=1&amp;b=2" title="t" rel="noopener noreferrer nofollow">x</a>');
    expect(sanitizeHtml('<a href="mailto:a@b.co">m</a>')).toBe('<a href="mailto:a@b.co" rel="noopener noreferrer nofollow">m</a>');
    expect(sanitizeHtml('<a href="/rel/path">r</a>')).toBe('<a href="/rel/path" rel="noopener noreferrer nofollow">r</a>');
  });

  test("unclosed tags are closed, stray closers dropped", () => {
    expect(sanitizeHtml("<p><strong>x")).toBe("<p><strong>x</strong></p>");
    expect(sanitizeHtml("x</p></div>")).toBe("x");
    expect(sanitizeHtml("<p><em>a</p>")).toBe("<p><em>a</em></p>");
  });

  test("non-strings become empty", () => {
    expect(sanitizeHtml(undefined as unknown as string)).toBe("");
  });
});

describe("sanitizeHtml: removes dangerous markup", () => {
  const cases: [string, string][] = [
    ["<script>alert(1)</script>ok", "ok"],
    ["<SCRIPT SRC=//evil.js></SCRIPT>ok", "ok"],
    ["<style>body{display:none}</style>ok", "ok"],
    ["<iframe src=//evil></iframe>ok", "ok"],
    ['<img src=x onerror="alert(1)">ok', "ok"],
    ["<svg onload=alert(1)><circle/></svg>ok", "ok"],
    ['<p onclick="alert(1)" style="x">t</p>', "<p>t</p>"],
    ["<p ONMOUSEOVER=alert(1)>t</p>", "<p>t</p>"],
    ["<!-- <script>alert(1)</script> -->ok", "ok"],
    ["<scr<script>ipt>alert(1)</script>", "ipt&gt;alert(1)"],
    ["<textarea><script>alert(1)</script></textarea>", ""],
    ["<math><mi xlink:href=javascript:alert(1)>x</mi></math>ok", "ok"],
    // Browsers end <noscript> at the first </noscript>, even inside an attribute; so do we.
    ["<noscript><p title=\"</noscript><img src=x onerror=alert(1)>\"></noscript>", '"&gt;'],
    ["<p>a</p><object data=x></object>", "<p>a</p>"],
  ];
  for (const [input, out] of cases) {
    test(JSON.stringify(input), () => {
      const got = sanitizeHtml(input);
      expect(got).toBe(out);
      expect(got.toLowerCase()).not.toContain("<script");
      expect(got.toLowerCase()).not.toMatch(/\son[a-z]+=/);
    });
  }

  const badHrefs = [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    " javascript:alert(1)",
    "java\tscript:alert(1)",
    "java&#x09;script:alert(1)",
    "&#106;avascript:alert(1)",
    "&#x6A;avascript:alert(1)",
    "jav&#x61;script:alert(1)",
    "vbscript:msgbox(1)",
    "data:text/html,<script>alert(1)</script>",
    "\u0001javascript:alert(1)",
    "//evil.com/x",
    "javascript&colon;alert(1)",
    "javascript&#58;alert(1)",
    "javascript&unknownentity;alert(1)",
  ];
  for (const href of badHrefs) {
    test(`drops href ${JSON.stringify(href)}`, () => {
      const got = sanitizeHtml(`<a href="${href.replace(/"/g, "&quot;")}">x</a>`);
      expect(got).toBe('<a rel="noopener noreferrer nofollow">x</a>');
    });
  }

  test("attribute values cannot break out", () => {
    const got = sanitizeHtml(`<a title='"><script>alert(1)</script>' href="https://a.b">x</a>`);
    expect(got).toBe('<a title="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;" href="https://a.b" rel="noopener noreferrer nofollow">x</a>');
  });

  test("unknown tags are unwrapped, their text kept", () => {
    expect(sanitizeHtml("<div><span>hi</span> <font color=red>there</font></div>")).toBe("hi there");
  });

  test("a lone < does not swallow the rest", () => {
    expect(sanitizeHtml("1 <2 and <p>ok</p>")).toBe("1 &lt;2 and <p>ok</p>");
  });

  test("deep nesting is capped", () => {
    const deep = "<blockquote>".repeat(500) + "x";
    const got = sanitizeHtml(deep);
    expect(got.split("<blockquote>").length - 1).toBeLessThanOrEqual(100);
    expect(got).toContain("x");
  });
});
