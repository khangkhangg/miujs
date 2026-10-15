import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertFsRuntime, localStore } from "../src/local.ts";
import { collect, toStream } from "../src/stream.ts";
import { str } from "./fixtures.ts";
import { failing, storeSuite } from "./store-suite.ts";

const dirs: string[] = [];
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "miu-files-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "none";
  } catch (err: any) {
    return err.code ?? String(err);
  }
}

describe("localStore", () => {
  storeSuite(() => localStore(fresh()));

  test("files survive a new store instance on the same directory", async () => {
    const dir = fresh();
    await localStore(dir).put("keep/me.txt", toStream("still here"), { contentType: "text/plain" });
    const got = (await localStore(dir).get("keep/me.txt"))!;
    expect(str(await collect(got.body))).toBe("still here");
    expect(got.contentType).toBe("text/plain");
  });

  test.each(["../escape.txt", "a/../../escape.txt", "/abs.txt", "a\\..\\..\\escape.txt", "a\0b", "C:/x", "a//b"])("rejects unsafe key %p even when called directly", async (key) => {
    const dir = fresh();
    const st = localStore(join(dir, "root"));
    expect(await code(st.put(key, toStream("x")))).toBe("MIU_E_FILES_KEY_INVALID");
    expect(await code(st.get(key))).toBe("MIU_E_FILES_KEY_INVALID");
    expect(await code(st.delete(key))).toBe("MIU_E_FILES_KEY_INVALID");
    expect(existsSync(join(dir, "escape.txt"))).toBe(false);
  });

  test.each(["CON", "a/nul.txt", "trailing.", "trailing "])("rejects names Windows would alias: %p", async (key) => {
    expect(await code(localStore(fresh()).put(key, toStream("x")))).toBe("MIU_E_FILES_KEY_INVALID");
  });

  test.each(["CONIN$", "a/conout$.txt", "a/COM¹", "LPT³.log", "a/con .txt"])("rejects the rest of the Windows device names: %p", async (key) => {
    expect(await code(localStore(fresh()).put(key, toStream("x")))).toBe("MIU_E_FILES_KEY_INVALID");
  });

  test("rejects keys that are not NFC, so two spellings of one name cannot alias one file (macOS)", async () => {
    const nfd = "a/café.txt";
    expect(await code(localStore(fresh()).put(nfd, toStream("x")))).toBe("MIU_E_FILES_KEY_INVALID");
    expect(await code(localStore(fresh()).put(nfd.normalize("NFC"), toStream("x")))).toBe("none");
  });

  test("writes are atomic: a failed upload leaves no partial or temp file", async () => {
    const dir = fresh();
    const st = localStore(dir);
    await expect(st.put("big.bin", failing("partial"))).rejects.toThrow();
    expect(existsSync(join(dir, "objects", "big.bin"))).toBe(false);
    expect(readdirSync(join(dir, "tmp"))).toEqual([]);
  });

  test("an upload id is never used as a path", async () => {
    const st = localStore(fresh());
    expect(await code(st.uploadPart("k", "../../objects", 1, toStream("x"), 1))).toBe("MIU_E_FILES_UPLOAD_NOT_FOUND");
    expect(await code(st.completeMultipart("k", "..", []))).toBe("MIU_E_FILES_UPLOAD_NOT_FOUND");
    // A path that resolves back to a real upload is still refused: ids are never joined into paths.
    const id = await st.createMultipart("k");
    expect(await code(st.uploadPart("k", `../multipart/${id}`, 1, toStream("x"), 1))).toBe("MIU_E_FILES_UPLOAD_NOT_FOUND");
  });

  test("a multipart upload is bound to its key", async () => {
    const st = localStore(fresh());
    const id = await st.createMultipart("one");
    expect(await code(st.uploadPart("two", id, 1, toStream("x"), 1))).toBe("MIU_E_FILES_UPLOAD_NOT_FOUND");
  });

  test("a key that collides with a directory is a conflict, not a crash", async () => {
    const st = localStore(fresh());
    await st.put("a/b", toStream("1"));
    expect(await code(st.put("a", toStream("2")))).toBe("MIU_E_FILES_KEY_CONFLICT");
  });

  test("only Bun and Node can use the file system", () => {
    expect(() => assertFsRuntime("bun")).not.toThrow();
    expect(() => assertFsRuntime("node")).not.toThrow();
    for (const rt of ["workerd", "deno", "unknown"]) {
      try {
        assertFsRuntime(rt);
        throw new Error("did not throw");
      } catch (err: any) {
        expect(err.code).toBe("MIU_E_FILES_RUNTIME");
        expect(err.fix).toContain("r2Store");
      }
    }
  });

  test("inspect shows the directory", () => {
    expect(localStore("./data/files").inspect!()).toEqual({ dir: "./data/files" });
  });
});
