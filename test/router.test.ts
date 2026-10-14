import { describe, expect, test } from "bun:test";
import { Router } from "../src/core/router.ts";

describe("Router", () => {
  test("matches a static path", () => {
    const r = new Router<string>();
    r.add("GET", "/health", "health");
    expect(r.find("GET", "/health")).toEqual({ handler: "health", params: {} });
  });

  test("returns null when nothing matches", () => {
    const r = new Router<string>();
    r.add("GET", "/a", "a");
    expect(r.find("GET", "/b")).toBeNull();
  });

  test("distinguishes methods", () => {
    const r = new Router<string>();
    r.add("GET", "/x", "get");
    r.add("POST", "/x", "post");
    expect(r.find("POST", "/x")?.handler).toBe("post");
    expect(r.find("DELETE", "/x")).toBeNull();
  });

  test("extracts named params", () => {
    const r = new Router<string>();
    r.add("GET", "/users/:id/posts/:postId", "h");
    expect(r.find("GET", "/users/42/posts/7")?.params).toEqual({ id: "42", postId: "7" });
  });

  test("decodes percent-encoded params", () => {
    const r = new Router<string>();
    r.add("GET", "/tags/:name", "h");
    expect(r.find("GET", "/tags/hello%20world")?.params.name).toBe("hello world");
  });

  test("static segment wins over param", () => {
    const r = new Router<string>();
    r.add("GET", "/users/:id", "param");
    r.add("GET", "/users/me", "static");
    expect(r.find("GET", "/users/me")?.handler).toBe("static");
    expect(r.find("GET", "/users/5")?.handler).toBe("param");
  });

  test("wildcard captures the rest of the path", () => {
    const r = new Router<string>();
    r.add("GET", "/files/*", "files");
    expect(r.find("GET", "/files/a/b/c.txt")?.params).toEqual({ "*": "a/b/c.txt" });
  });

  test("ALL matches any method", () => {
    const r = new Router<string>();
    r.add("ALL", "/any", "any");
    expect(r.find("PATCH", "/any")?.handler).toBe("any");
  });

  test("ignores trailing slash", () => {
    const r = new Router<string>();
    r.add("GET", "/about", "about");
    expect(r.find("GET", "/about/")?.handler).toBe("about");
  });

  test("allowedMethods lists methods registered for a path", () => {
    const r = new Router<string>();
    r.add("GET", "/x", "g");
    r.add("POST", "/x", "p");
    expect(r.allowedMethods("/x").sort()).toEqual(["GET", "POST"]);
  });
});
