import { describe, expect, test } from "bun:test";
import { checkKey } from "../src/keys.ts";

describe("checkKey", () => {
  test.each(["a", "avatars/u1.png", "tours/house-12/pano 01.jpg", "a.b/c..d/e", "ünïcode/文件.glb"])("accepts %p", (k) => {
    expect(checkKey(k)).toBe(k);
  });

  test.each([
    ["empty", ""],
    ["dot-dot segment", "a/../b"],
    ["leading dot-dot", "../etc/passwd"],
    ["trailing dot-dot", "a/.."],
    ["dot segment", "a/./b"],
    ["absolute", "/etc/passwd"],
    ["backslash", "a\\b"],
    ["backslash traversal", "..\\..\\windows"],
    ["colon (Windows streams)", "a.txt:stream"],
    ["NUL", "a\0b"],
    ["control char", "a\nb"],
    ["empty segment", "a//b"],
    ["trailing slash", "a/"],
    ["drive letter", "C:/x"],
    ["too long", "x".repeat(1025)],
  ])("rejects %s", (_, k) => {
    try {
      checkKey(k);
      throw new Error("did not throw");
    } catch (err: any) {
      expect(err.code).toBe("MIU_E_FILES_KEY_INVALID");
      expect(err.status).toBe(400);
      expect(err.fix).toBeTruthy();
    }
  });

  test("rejects non-strings", () => {
    expect(() => checkKey(42 as any)).toThrow(/key/i);
  });
});
