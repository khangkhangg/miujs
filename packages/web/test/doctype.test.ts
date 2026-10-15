import { expect, test } from "bun:test";
import { html, raw, render, renderPage } from "../src/index.ts";

const text = (r: Response) => r.text();

test("render adds <!doctype html> when the content is a full document", async () => {
  expect(await text(render(html`<html><body>hi</body></html>`))).toBe("<!doctype html><html><body>hi</body></html>");
  expect(await text(render(html`  <HTML lang="en"></HTML>`))).toBe("<!doctype html>  <HTML lang=\"en\"></HTML>");
});

test("fragments and documents that already have a doctype are unchanged", async () => {
  expect(await text(render(html`<p>hi</p>`))).toBe("<p>hi</p>");
  expect(await text(render(raw("<!DOCTYPE html><html></html>")))).toBe("<!DOCTYPE html><html></html>");
});

test("doctype: false turns it off, doctype: true forces it", async () => {
  expect(await text(render(html`<html></html>`, { doctype: false }))).toBe("<html></html>");
  expect(await text(render(html`<main></main>`, { doctype: true }))).toBe("<!doctype html><main></main>");
});

test("renderPage follows the same rule: full page gets a doctype, the htmx fragment does not", async () => {
  const layout = (body: unknown) => html`<html><body>${body}</body></html>`;
  const page = (headers: Record<string, string>) => renderPage({ headers: new Headers(headers) }, html`<p>x</p>`, layout);
  expect(await text(page({}))).toBe("<!doctype html><html><body><p>x</p></body></html>");
  expect(await text(page({ "hx-request": "true" }))).toBe("<p>x</p>");
});
