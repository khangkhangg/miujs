import { describe, expect, test } from "bun:test";
import { MiuError } from "../src/errors.ts";
import { Router, normalizePath, pathParams } from "../src/router.ts";

function router(...patterns: string[]) {
  const r = new Router<string>();
  for (const p of patterns) r.add(p, p);
  return r;
}

function codeOf(fn: () => void): string | undefined {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(MiuError);
    return (e as MiuError).code;
  }
  return undefined;
}

describe("normalizePath", () => {
  test("strips one trailing slash and adds leading slash", () => {
    expect(normalizePath("/a/")).toBe("/a");
    expect(normalizePath("a/b")).toBe("/a/b");
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("")).toBe("/");
  });
});

describe("pathParams", () => {
  test("lists param and wildcard names in order", () => {
    expect(pathParams("/users/:id/posts/:postId")).toEqual(["id", "postId"]);
    expect(pathParams("/files/*path")).toEqual(["path"]);
    expect(pathParams("/files/*")).toEqual(["*"]);
    expect(pathParams("/static")).toEqual([]);
  });
});

describe("static routes", () => {
  test("exact match with empty params", () => {
    const r = router("/", "/health", "/a/b");
    expect(r.find("/")).toEqual({ value: "/", params: {} });
    expect(r.find("/health")).toEqual({ value: "/health", params: {} });
    expect(r.find("/a/b")?.value).toBe("/a/b");
    expect(r.find("/a")).toBeNull();
    expect(r.find("/nope")).toBeNull();
  });

  test("trailing slash tolerance on both sides", () => {
    const r = router("/health", "/docs/");
    expect(r.find("/health/")?.value).toBe("/health");
    expect(r.find("/docs")?.value).toBe("/docs/");
  });
});

describe("params", () => {
  test("captures named params", () => {
    const r = router("/users/:id/posts/:postId");
    expect(r.find("/users/42/posts/7")).toEqual({ value: "/users/:id/posts/:postId", params: { id: "42", postId: "7" } });
  });

  test("trailing slash on dynamic route", () => {
    const r = router("/users/:id");
    expect(r.find("/users/42/")).toEqual({ value: "/users/:id", params: { id: "42" } });
  });

  test("empty segment does not match a param", () => {
    const r = router("/users/:id/x");
    expect(r.find("/users//x")).toBeNull();
    expect(router("/users/:id").find("/users/")).toBeNull();
  });

  test("percent-decodes params", () => {
    const r = router("/users/:name");
    expect(r.find("/users/J%C3%BCrgen%20M")?.params).toEqual({ name: "Jürgen M" });
  });

  test("malformed percent-encoding is returned raw, not thrown", () => {
    const r = router("/users/:name", "/f/*rest");
    expect(r.find("/users/%E0%A4%A")?.params).toEqual({ name: "%E0%A4%A" });
    expect(r.find("/f/a/%zz")?.params).toEqual({ rest: "a/%zz" });
  });
});

describe("wildcards", () => {
  test("captures the rest of the path, decoded", () => {
    const r = router("/files/*path");
    expect(r.find("/files/a/b/c.txt")).toEqual({ value: "/files/*path", params: { path: "a/b/c.txt" } });
    expect(r.find("/files/a%20b")?.params.path).toBe("a b");
  });

  test("unnamed wildcard uses '*'", () => {
    expect(router("/x/*").find("/x/y/z")?.params).toEqual({ "*": "y/z" });
  });

  test("wildcard requires at least one segment", () => {
    expect(router("/files/*path").find("/files")).toBeNull();
  });
});

describe("priority and backtracking", () => {
  test("static beats param", () => {
    const r = router("/users/:id", "/users/new");
    expect(r.find("/users/new")).toEqual({ value: "/users/new", params: {} });
    expect(r.find("/users/5")?.params).toEqual({ id: "5" });
  });

  test("static in the tree beats param regardless of registration order", () => {
    const r = router("/users/:id/edit", "/users/me/:tab");
    expect(r.find("/users/me/edit")).toEqual({ value: "/users/me/:tab", params: { tab: "edit" } });
  });

  test("backtracks from a failed static branch to param", () => {
    const r = router("/users/me/settings/:tab", "/users/:id/posts");
    // "me" goes down the static branch first, which cannot match ".../posts"
    expect(r.find("/users/me/posts")).toEqual({ value: "/users/:id/posts", params: { id: "me" } });
  });

  test("backtracks from a failed param branch to wildcard", () => {
    const r = router("/files/:id/meta", "/files/*path");
    expect(r.find("/files/1/meta")).toEqual({ value: "/files/:id/meta", params: { id: "1" } });
    expect(r.find("/files/1/other")).toEqual({ value: "/files/*path", params: { path: "1/other" } });
  });

  test("failed branches do not leak params", () => {
    const r = router("/a/:x/b/:y/c", "/a/*rest");
    expect(r.find("/a/1/b/2/d")).toEqual({ value: "/a/*rest", params: { rest: "1/b/2/d" } });
  });

  test("param beats wildcard", () => {
    const r = router("/f/*rest", "/f/:id");
    expect(r.find("/f/1")?.value).toBe("/f/:id");
    expect(r.find("/f/1/2")?.value).toBe("/f/*rest");
  });
});

describe("configuration errors", () => {
  test("duplicate static route", () => {
    const r = router("/a");
    expect(codeOf(() => r.add("/a/", "x"))).toBe("MIU_E_ROUTE_DUPLICATE");
  });

  test("duplicate dynamic route", () => {
    const r = router("/a/:id");
    expect(codeOf(() => r.add("/a/:id", "x"))).toBe("MIU_E_ROUTE_DUPLICATE");
  });

  test("duplicate wildcard", () => {
    const r = router("/a/*p");
    expect(codeOf(() => r.add("/a/*q", "x"))).toBe("MIU_E_ROUTE_DUPLICATE");
  });

  test("different param names at same position conflict", () => {
    const r = router("/u/:id");
    let err: MiuError | undefined;
    try {
      r.add("/u/:userId/posts", "x");
    } catch (e) {
      err = e as MiuError;
    }
    expect(err?.code).toBe("MIU_E_ROUTE_CONFLICT");
    expect(err?.status).toBe(500);
    expect(err?.fix).toContain(":id");
  });

  test("same param name at same position is fine", () => {
    const r = router("/u/:id", "/u/:id/posts");
    expect(r.find("/u/1/posts")?.params).toEqual({ id: "1" });
  });

  test("non-final wildcard is invalid", () => {
    expect(codeOf(() => router().add("/a/*rest/b", "x"))).toBe("MIU_E_ROUTE_INVALID");
  });
});

describe("all()", () => {
  test("returns normalized patterns in registration order", () => {
    expect(router("/b/", "a/:id").all()).toEqual(["/b", "/a/:id"]);
  });
});

describe("lookup paths", () => {
  test("a node with many static children (Map lookup) matches like a short one (scan)", () => {
    const names = Array.from({ length: 12 }, (_, i) => `seg${i}`);
    const r = router(...names.map((n) => `/${n}/:id`), "/s/:id", "/seg/:id");
    for (const n of names) expect(r.find(`/${n}/7`)).toEqual({ value: `/${n}/:id`, params: { id: "7" } });
    expect(r.find("/seg/1")?.value).toBe("/seg/:id");
    expect(r.find("/se/1")).toBeNull();
    expect(r.find("/seg12/1")).toBeNull();
  });

  test("a static segment must match whole, not as a prefix", () => {
    const r = router("/user/:id", "/users/:id/x");
    expect(r.find("/users/1")).toBeNull();
    expect(r.find("/user/1")?.params).toEqual({ id: "1" });
  });

  test("static paths longer than 255 characters", () => {
    const long = "/" + "a".repeat(300);
    const longer = "/" + "b".repeat(400);
    const r = router(long, longer);
    expect(r.find(long)?.value).toBe(long);
    expect(r.find(longer + "/")?.value).toBe(longer);
    expect(r.find("/" + "a".repeat(299))).toBeNull();
  });

  test("lookup writes params into the given object and returns the value", () => {
    const r = router("/users/:id", "/");
    const params: Record<string, string> = {};
    expect(r.lookup("/users/9", params)).toBe("/users/:id");
    expect(params).toEqual({ id: "9" });
    const none: Record<string, string> = {};
    expect(r.lookup("/nope/x", none)).toBeUndefined();
    expect(none).toEqual({});
  });
});
