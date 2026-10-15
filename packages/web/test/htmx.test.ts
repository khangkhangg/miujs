import { describe, expect, test } from "bun:test";
import { miu, route, type Context } from "miujs";
import { html, hxRedirect, hxTrigger, isHtmx, renderPage } from "../src/index.ts";

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    expect((e as any).fix).toBeTruthy();
    return (e as any).code;
  }
  return undefined;
}

async function withCtx<T>(headers: Record<string, string>, fn: (ctx: Context) => T): Promise<T> {
  let out!: T;
  const r = route.get("/", {
    handler: (ctx) => {
      out = fn(ctx as unknown as Context);
      return null;
    },
  });
  await miu({ routes: [r], logLevel: "silent" }).request("/", { headers });
  return out;
}

describe("isHtmx", () => {
  test("true only when HX-Request: true", async () => {
    expect(await withCtx({ "hx-request": "true" }, isHtmx)).toBe(true);
    expect(await withCtx({}, isHtmx)).toBe(false);
    expect(await withCtx({ "hx-request": "false" }, isHtmx)).toBe(false);
  });
});

describe("hxRedirect", () => {
  test("sets HX-Redirect on an empty response", async () => {
    const res = hxRedirect("/dashboard?tab=1");
    expect(res.status).toBe(204);
    expect(res.headers.get("hx-redirect")).toBe("/dashboard?tab=1");
    expect(await res.text()).toBe("");
    expect(hxRedirect("https://example.com/x").headers.get("hx-redirect")).toBe("https://example.com/x");
  });

  test("refuses script URLs and protocol-relative tricks", () => {
    for (const u of ["javascript:alert(1)", " JavaScript:alert(1)", "data:text/html,x", "//evil.example", "/\\evil.example", "vbscript:x"]) {
      expect([u, codeOf(() => hxRedirect(u))]).toEqual([u, "MIU_E_WEB_HX_URL"]);
    }
  });
});

describe("hxTrigger", () => {
  test("event name only", () => {
    const res = hxTrigger("saved");
    expect(res.status).toBe(204);
    expect(res.headers.get("hx-trigger")).toBe("saved");
  });

  test("event with detail is JSON, ASCII-safe", () => {
    const res = hxTrigger("toast", { message: "Đã lưu ✓", level: "ok" });
    const raw = res.headers.get("hx-trigger")!;
    expect(/^[\x20-\x7e]*$/.test(raw)).toBe(true);
    expect(JSON.parse(raw)).toEqual({ toast: { message: "Đã lưu ✓", level: "ok" } });
  });

  test("adds the header to an existing response", async () => {
    const base = new Response("<p>ok</p>", { headers: { "content-type": "text/html" } });
    const res = hxTrigger("saved", undefined, base);
    expect(res.headers.get("hx-trigger")).toBe("saved");
    expect(await res.text()).toBe("<p>ok</p>");
  });

  test("works on responses with immutable headers", async () => {
    const base = Response.redirect("http://x/", 302);
    const res = hxTrigger("saved", undefined, base);
    expect(res.headers.get("hx-trigger")).toBe("saved");
    expect(res.status).toBe(302);
  });
});

describe("renderPage", () => {
  const layout = (body: unknown) => html`<html><body>${body}</body></html>`;

  test("htmx requests get the partial; others get the full page; Vary is set", async () => {
    const partial = html`<p>${"<x>"}</p>`;
    const hx = await withCtx({ "hx-request": "true" }, (ctx) => renderPage(ctx, partial, layout));
    expect(await hx.text()).toBe("<p>&lt;x&gt;</p>");
    expect(hx.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(hx.headers.get("vary")).toBe("HX-Request");
    const full = await withCtx({}, (ctx) => renderPage(ctx, partial, layout));
    expect(await full.text()).toBe("<!doctype html><html><body><p>&lt;x&gt;</p></body></html>");
    expect(full.headers.get("vary")).toBe("HX-Request");
  });

  test("boosted navigations get the full page", async () => {
    const res = await withCtx({ "hx-request": "true", "hx-boosted": "true" }, (ctx) => renderPage(ctx, html`<p>x</p>`, layout));
    expect(await res.text()).toBe("<!doctype html><html><body><p>x</p></body></html>");
  });

  test("passes status and headers through", async () => {
    const res = await withCtx({}, (ctx) => renderPage(ctx, html`x`, layout, { status: 422, headers: { "x-a": "1" } }));
    expect(res.status).toBe(422);
    expect(res.headers.get("x-a")).toBe("1");
  });
});
