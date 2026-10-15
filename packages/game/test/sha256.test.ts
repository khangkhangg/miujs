import { expect, test } from "bun:test";
import { hmacSha256, sha256 } from "../src/sha256.ts";

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const enc = new TextEncoder();

test("sha256 matches FIPS 180-2 examples", () => {
  expect(hex(sha256(enc.encode("abc")))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect(hex(sha256(enc.encode("")))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  expect(hex(sha256(enc.encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")))).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
});

test("hmacSha256 matches RFC 4231 test cases 1, 2 and 6 (long key)", () => {
  expect(hex(hmacSha256(new Uint8Array(20).fill(0x0b), enc.encode("Hi There")))).toBe("b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");
  expect(hex(hmacSha256(enc.encode("Jefe"), enc.encode("what do ya want for nothing?")))).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  expect(hex(hmacSha256(new Uint8Array(131).fill(0xaa), enc.encode("Test Using Larger Than Block-Size Key - Hash Key First")))).toBe("60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54");
});

test("agrees with Web Crypto on random inputs", async () => {
  for (let i = 0; i < 50; i++) {
    const key = crypto.getRandomValues(new Uint8Array(1 + (i * 7) % 90));
    const msg = crypto.getRandomValues(new Uint8Array((i * 37) % 300));
    const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    expect(hex(hmacSha256(key, msg))).toBe(hex(new Uint8Array(await crypto.subtle.sign("HMAC", k, msg))));
  }
});
