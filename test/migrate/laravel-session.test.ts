import { describe, expect, test } from "bun:test";
import { Miu } from "../../src/core/app.ts";
import {
  decodeLaravelSession,
  decryptLaravelCookie,
  laravelCookiePrefix,
  laravelDecrypt,
  laravelEncrypt,
  laravelSessionBridge,
  parseAppKey,
} from "../../src/migrate/laravel-session.ts";

// PHP side of the fixtures: a copy of Laravel 11's Encrypter::encrypt (openssl_encrypt) and
// CookieValuePrefix::create, with an injectable IV. FX below was generated with PHP 8.3.6 running it;
// the "live PHP" tests run it again when `php` is installed.
const PHP_LARAVEL = `
function laravel_encrypt($value, $key, $cipher, $iv, $serialize) {
  $value = \\openssl_encrypt($serialize ? serialize($value) : $value, strtolower($cipher), $key, 0, $iv, $tag);
  $iv = base64_encode($iv);
  $tag = base64_encode($tag ?? '');
  $mac = str_ends_with(strtolower($cipher), '-gcm') ? '' : hash_hmac('sha256', $iv.$value, $key);
  return base64_encode(json_encode(compact('iv', 'value', 'mac', 'tag'), JSON_UNESCAPED_SLASHES));
}
function laravel_decrypt($payload, $key, $cipher) {
  $p = json_decode(base64_decode($payload), true);
  $aead = str_ends_with(strtolower($cipher), '-gcm');
  if (!$aead && !hash_equals(hash_hmac('sha256', $p['iv'].$p['value'], $key), $p['mac'])) return 'BAD MAC';
  return \\openssl_decrypt($p['value'], strtolower($cipher), $key, 0, base64_decode($p['iv']), $aead ? base64_decode($p['tag']) : '');
}
function cookie_prefix($name, $key) { return hash_hmac('sha1', $name.'v2', $key).'|'; }
`;

const FX = {
  "appKey256": "base64:KioqKioqKioqKioqKioqKjAxMjM0NTY3ODlhYmNkZWY=",
  "appKey128": "base64:MDEyMzQ1Njc4OWFiY2RlZg==",
  "oldKey256": "base64:BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
  "sid": "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCd",
  "sessionData": "a:4:{s:6:\"_token\";s:16:\"csrf-token-value\";s:50:\"login_web_59ba36addc2b2f9401580f014c7f58ea4e30989d\";i:42;s:4:\"name\";s:4:\"Zoë\";s:6:\"_flash\";a:2:{s:3:\"old\";a:0:{}s:3:\"new\";a:0:{}}}",
  "cookieCbc": "eyJpdiI6Ik1ERXlNelExTmpjNE9VRkNRMFJGUmc9PSIsInZhbHVlIjoiVEtQWG1GR1pzRjQ1QXZ2VFlFcHE5R3ZXeVk0MkhOZDE0TndBOHIzSmU1c2pWNDgvU0hPSDN4NS9OZ2ZvcHAycFhaUi9oWllERFV4TmEwa3F0bzBVbFdOSmwvUzFlT2c3bEMxOWRZN3liQkVZejJmNzhEMEYyV1A1YlM3Z1czVVUiLCJtYWMiOiI5MzM1YjA1YzM2MjBmYTBlZmQ3NDU4ZGJjNzkwNzFiOWExNGVjODg5ZmFmNTIwZjE5NDNjMWJlNmRjYTg2N2I0IiwidGFnIjoiIn0=",
  "cookieCbcOldKey": "eyJpdiI6Ik1ERXlNelExTmpjNE9VRkNRMFJGUmc9PSIsInZhbHVlIjoiTDNKKzNrSUxiRVRhbHhzZWo3a3hlQVVGK3ZNQmdRb0JQYmxDQi9pNFhJbTlwczBEZTNtKzRPM1hXMWkyRmRkRy8zTFVKaWNpQUZaQkp0eURTbkdFSFhyOTcyNkpsd3l6WnU0a3BySjdUamhsUWZVWG51ZlZLNEVYU2pkcFdTVHciLCJtYWMiOiJjNDQyNDhiZjBkMDkzY2UzMTAzYTllNDJkZTgwNTRjOTIwNDhmMjQ3ZTk2Y2UzMjk3ODlkNTE5NmVmOTE2OTZiIiwidGFnIjoiIn0=",
  "cookieCbcOtherName": "eyJpdiI6Ik1ERXlNelExTmpjNE9VRkNRMFJGUmc9PSIsInZhbHVlIjoiVzFXbEtlaXo5MG9Ga1ZZcURDR21rOCtTY3J0ak8rTHNtWHQrbm5vS2lMOVpRSzlEWEV4K1JxZlJtQTEvWEhTeCt1RGxFUFRQZnlRblhCZktBTTZ2dDlyZ05LakFwNzN2bGd1VEVxa0ZZcmlZSGt4Y3R0WTMzTThSazNLQlZVdGoiLCJtYWMiOiJjMTgzNDJiZDhlZDNjNmM5Y2Q2ZWE1NDIxZDc2YTUyZDQxMDkzM2UxMDU4OTQ5M2Q2ODkxY2I0Yjc4ZmZkYzhmIiwidGFnIjoiIn0=",
  "cookieGcm": "eyJpdiI6Ik1ERXlNelExTmpjNE9VRkMiLCJ2YWx1ZSI6ImFwZjJacVdJd0pxcjFSSTdKNlhhZEFhSkVkaElVWVUySjhGV1RkMm9KMGxPMzgvU3VtNHlZb2xDTWFtYnlHYXA5VkRUN2RSVzVOQkUzRzRzWVVPcnRIR3Y3UVdXbXVINURMQlUyT2FoVStCYSIsIm1hYyI6IiIsInRhZyI6Ikk2a1NqS1J3SjJVaTIySDViQkN0M1E9PSJ9",
  "cookie128": "eyJpdiI6Ik1ERXlNelExTmpjNE9VRkNRMFJGUmc9PSIsInZhbHVlIjoiUGNKNlpEZ1MxdHhkaVZhbHlLTUhzS1lydlN2MUtiRGZQQW5XcHJNOTNGd2dKd3BvbkhaMzVhelBJcHM4WVVaU2pxaWpTNWxIb3Z3Tjh4U0xKckJON1pPQ0IyWHFCa2d1UEdRNTdOUmQrV2pBTWxMbFVhQi9WSElPTTB6aDlKTnIiLCJtYWMiOiJjYzY3ZDVkNDAzZDc3Y2Q0YTMyNjE2ZmVmNWI5N2QyOGVjZjc0OThjNWI5ODlkNjhmODBiZjg1NmQwOTYzOTVlIiwidGFnIjoiIn0=",
  "encryptedSession": "eyJpdiI6Ik1ERXlNelExTmpjNE9VRkNRMFJGUmc9PSIsInZhbHVlIjoiRkU0R0J1ZzJ1RUpMMU83VGxlYm5DSkdxaHJQTmNUVTY5c05RVXpydGhLcnI1emJmZFNTVW5SMVk0blNva2w3eEI5S2psdk1oVDJaMDNTRmFQNFV2cm9MTEpFekZCRGlZcmhZUkVmcVlzTXc2OHUyNUUyRDM1eThMejZlci9qbVJWVCtUTmx0UVdocktXTHBhbGpmWmR3MnBBcGNIdkkzbm1nMFFMblZ4TjNrd2lmZ0dTUGgrb3ZJenFQdVd3NDBVaHk0bzJHc0sxaUtOT2xhYmVVRjg4cFZVVWJ4ZktzNHRlMGNwME1nUTlQL09OVUF0RkhnOXl5VllwRGpPZDBIQiIsIm1hYyI6IjFkZmUwOTk1MTg3MWRhMjIyNzIzNGZhYjRmODA4ODM5MjI3NzNjMjAzYjEyZjY4ZDQ5ODU4ZWZjM2NkYjAwYjUiLCJ0YWciOiIifQ==",
  "encryptedSessionGcm": "eyJpdiI6Ik1ERXlNelExTmpjNE9VRkMiLCJ2YWx1ZSI6IktaMmhNL3FDZzUyajJCRjBNZjdWTDBLd0FZOUFBOXdpS05NS0hkNzNZQndMbXNxYy9XTS9NSnN1Sll1VCtHWE1wbXFEazRnaHFQTmI2blVSU21HNGdWYkRybGZHbStTc1hlSUEwcjNTVjVvSzRPQVdIeXdzSDRyaVRsOVE3NjVkQTUrQXByaUpOako4VTZnbVpzT2Y5Rm1ORFhOZEpFSHhTMUhJQnU0bUptZDF2THlNblVXSXlXY3R4QVVyeUQ1NWtnUXBVMG9VR1UrQ21tdXdZcnMvUWtCc2NodVh3cmxqaldrQkw3UXZ4WmlVUjcyMVlJVDRueit1czFnPSIsIm1hYyI6IiIsInRhZyI6ImFESlV6YXNQVlN2M3o4ZTkySHFjdkE9PSJ9",
  "jsonSession": "{\"_token\":\"csrf-token-value\",\"login_web_59ba36addc2b2f9401580f014c7f58ea4e30989d\":42,\"name\":\"Zo\\u00eb\",\"_flash\":{\"old\":[],\"new\":[]}}",
  "encryptString": "eyJpdiI6Ik1ERXlNelExTmpjNE9VRkNRMFJGUmc9PSIsInZhbHVlIjoiQnNPUjVmWitWcHNKNGRVQkNIRjJYdz09IiwibWFjIjoiMmNmZTkzMGEwYzc1NWIyNWMzNjQ3YzMyNTY2OTc1MGE1OGNkYWMxZmIzZWRlYjIwNjdkZmY3MGY5YmE5MjY0NSIsInRhZyI6IiJ9",
  "encryptSerialized": "eyJpdiI6Ik1ERXlNelExTmpjNE9VRkNRMFJGUmc9PSIsInZhbHVlIjoib1JITC90NzQ3c2JXa0R6TExJZ256V2RRMW1pVkRQYWFITldOMnBBWjZQcz0iLCJtYWMiOiI3YmQzNzkzYjk2NjM3YTI3MjZhZmYyZjI4MDE3OWUxNGE0MTE0OWUxZDIwZGMyNTY2ZjE2Mzg3YWY0YWVmNWYxIiwidGFnIjoiIn0="
} as const;

const ATTRS = {
  _token: "csrf-token-value",
  login_web_59ba36addc2b2f9401580f014c7f58ea4e30989d: 42,
  name: "Zoë",
  _flash: { old: [], new: [] },
};

const K256 = { appKey: FX.appKey256 };

describe("Laravel Encrypter", () => {
  test("parses APP_KEY (base64: prefix or raw)", () => {
    expect(parseAppKey(FX.appKey256).length).toBe(32);
    expect(parseAppKey(FX.appKey128).length).toBe(16);
    expect(parseAppKey("0123456789abcdef").length).toBe(16);
    expect(() => parseAppKey("base64:!!!")).toThrow(/APP_KEY/);
  });

  test("decrypts AES-256-CBC payloads made by PHP (encryptString and encrypt)", async () => {
    expect(await laravelDecrypt(FX.encryptString, K256)).toBe("héllo wörld");
    expect(await laravelDecrypt(FX.encryptSerialized, K256)).toBe('a:1:{s:1:"a";i:1;}');
  });

  test("decrypts AES-256-GCM and AES-128-CBC", async () => {
    const gcm = await laravelDecrypt(FX.cookieGcm, { ...K256, cipher: "aes-256-gcm" });
    expect(gcm?.endsWith(FX.sid)).toBe(true);
    const c128 = await laravelDecrypt(FX.cookie128, { appKey: FX.appKey128, cipher: "aes-128-cbc" });
    expect(c128?.endsWith(FX.sid)).toBe(true);
  });

  test("rejects a bad MAC, a wrong key, tampering and malformed payloads", async () => {
    const p = JSON.parse(atob(FX.encryptString));
    const flip = (o: object) => btoa(JSON.stringify(o));
    expect(await laravelDecrypt(flip({ ...p, mac: "0".repeat(64) }), K256)).toBeUndefined();
    expect(await laravelDecrypt(flip({ ...p, value: "AAAA" + p.value.slice(4) }), K256)).toBeUndefined();
    expect(await laravelDecrypt(FX.encryptString, { appKey: FX.oldKey256 })).toBeUndefined();
    expect(await laravelDecrypt("not base64 json", K256)).toBeUndefined();
    expect(await laravelDecrypt(flip({ iv: p.iv, value: p.value }), K256)).toBeUndefined(); // no mac
    expect(await laravelDecrypt(flip({ ...p, iv: btoa("short") }), K256)).toBeUndefined();
  });

  test("the cipher is configuration, never taken from the payload (no downgrade to unauthenticated)", async () => {
    // A GCM payload has an empty mac: it must not be accepted when the app is configured for CBC…
    expect(await laravelDecrypt(FX.cookieGcm, K256)).toBeUndefined();
    // …and a CBC payload carrying a tag is rejected like Laravel does.
    const p = JSON.parse(atob(FX.encryptString));
    expect(await laravelDecrypt(btoa(JSON.stringify({ ...p, tag: btoa("x".repeat(16)) })), K256)).toBeUndefined();
    // GCM requires a 16-byte tag
    const g = JSON.parse(atob(FX.cookieGcm));
    expect(await laravelDecrypt(btoa(JSON.stringify({ ...g, tag: btoa("short") })), { ...K256, cipher: "aes-256-gcm" })).toBeUndefined();
    expect(await laravelDecrypt(btoa(JSON.stringify({ ...g, tag: "" })), { ...K256, cipher: "aes-256-gcm" })).toBeUndefined();
  });

  test("key length must match the cipher", async () => {
    await expect(laravelDecrypt(FX.cookie128, { appKey: FX.appKey128 })).rejects.toThrow(/32-byte/);
  });

  test("previous keys (APP_PREVIOUS_KEYS) are tried after the current one", async () => {
    expect(await laravelDecrypt(FX.cookieCbcOldKey, { appKey: [FX.appKey256, FX.oldKey256] })).toContain(FX.sid);
  });

  test("laravelEncrypt round-trips (CBC and GCM)", async () => {
    for (const cipher of ["aes-256-cbc", "aes-256-gcm"] as const) {
      const enc = await laravelEncrypt("hi ✓", { ...K256, cipher });
      expect(await laravelDecrypt(enc, { ...K256, cipher })).toBe("hi ✓");
    }
  });
});

describe("Laravel cookies and sessions", () => {
  test("cookie value prefix = hmac-sha1(name + 'v2', key) + '|'", async () => {
    const prefix = await laravelCookiePrefix("laravel_session", parseAppKey(FX.appKey256));
    expect(prefix).toMatch(/^[0-9a-f]{40}\|$/);
    expect(await laravelDecrypt(FX.cookieCbc, K256)).toBe(prefix + FX.sid);
  });

  test("decryptLaravelCookie validates and strips the prefix", async () => {
    expect(await decryptLaravelCookie(FX.cookieCbc, "laravel_session", K256)).toBe(FX.sid);
    expect(await decryptLaravelCookie(FX.cookieCbcOldKey, "laravel_session", { appKey: [FX.appKey256, FX.oldKey256] })).toBe(FX.sid);
    // a validly encrypted value from another cookie can't be swapped in
    expect(await decryptLaravelCookie(FX.cookieCbcOtherName, "laravel_session", K256)).toBeUndefined();
    expect(await decryptLaravelCookie(FX.cookieCbcOtherName, "XSRF-TOKEN", K256)).toBe(FX.sid);
  });

  test("decodes plain, encrypted (session.encrypt) and JSON session payloads", async () => {
    expect(await decodeLaravelSession(FX.sessionData, K256)).toEqual(ATTRS);
    expect(await decodeLaravelSession(FX.encryptedSession, { ...K256, encrypted: true })).toEqual(ATTRS);
    expect(await decodeLaravelSession(FX.encryptedSessionGcm, { ...K256, cipher: "aes-256-gcm", encrypted: true })).toEqual(ATTRS);
    expect(await decodeLaravelSession(FX.jsonSession, { ...K256, serialization: "json" })).toEqual(ATTRS);
    expect(await decodeLaravelSession(FX.encryptedSession, { ...K256, encrypted: true, appKey: FX.oldKey256 })).toBeUndefined();
    expect(await decodeLaravelSession("garbage", K256)).toBeUndefined();
  });

  test("laravelSessionBridge exposes the session through c.get('legacySession')", async () => {
    const reads: string[] = [];
    const app = new Miu({ logger: false })
      .use(
        laravelSessionBridge({
          appKey: FX.appKey256,
          encrypted: true,
          read: async (id) => (reads.push(id), id === FX.sid ? FX.encryptedSession : null),
        }),
      )
      .get("/me", (c) => ({ s: c.get("legacySession") ?? null }));
    const cookie = `laravel_session=${encodeURIComponent(FX.cookieCbc)}`;
    const res = await app.request("/me", { headers: { cookie } });
    expect(await res.json()).toEqual({ s: ATTRS });
    expect(reads).toEqual([FX.sid]);

    // wrong cookie name binding, garbage, missing → no session and no read
    for (const c of [`laravel_session=${encodeURIComponent(FX.cookieCbcOtherName)}`, "laravel_session=abc", ""]) {
      const r = await app.request("/me", { headers: c ? { cookie: c } : {} });
      expect(await r.json()).toEqual({ s: null });
    }
    expect(reads).toEqual([FX.sid]);
  });

  test("custom cookie name and AES-128 key", async () => {
    const app = new Miu({ logger: false })
      .use(laravelSessionBridge({ appKey: FX.appKey128, cipher: "aes-128-cbc", cookieName: "myapp_session", read: async () => FX.sessionData }))
      .get("/me", (c) => ({ s: c.get("legacySession") ?? null }));
    const res = await app.request("/me", { headers: { cookie: `myapp_session=${encodeURIComponent(FX.cookie128)}` } });
    expect(await res.json()).toEqual({ s: ATTRS });
  });
});

describe("Laravel: live PHP cross-check", () => {
  const hasPhp = Bun.spawnSync(["php", "-r", "echo function_exists('openssl_encrypt') ? 'ok' : 'no';"]).stdout?.toString() === "ok";
  const php = (code: string, ...args: string[]) => {
    const r = Bun.spawnSync(["php", "-r", PHP_LARAVEL + code, "--", ...args]);
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return r.stdout.toString();
  };

  test.skipIf(!hasPhp)("PHP-encrypted payloads (random IVs) decrypt in Miu, for every cipher", async () => {
    for (const [cipher, appKey] of [
      ["aes-256-cbc", FX.appKey256], ["aes-256-gcm", FX.appKey256], ["aes-128-cbc", FX.appKey128], ["aes-128-gcm", FX.appKey128],
    ] as const) {
      const out = php(
        `$k = base64_decode(substr($argv[1], 7)); $c = $argv[2];
         echo laravel_encrypt(cookie_prefix('laravel_session', $k) . 'sid-' . $c, $k, $c, random_bytes(openssl_cipher_iv_length($c)), false);`,
        appKey, cipher,
      );
      expect(await decryptLaravelCookie(out, "laravel_session", { appKey, cipher })).toBe(`sid-${cipher}`);
    }
  });

  test.skipIf(!hasPhp)("Miu-encrypted payloads decrypt in PHP", async () => {
    for (const cipher of ["aes-256-cbc", "aes-256-gcm"] as const) {
      const enc = await laravelEncrypt("from miu ü", { appKey: FX.appKey256, cipher });
      const out = php(`echo laravel_decrypt($argv[1], base64_decode(substr($argv[2], 7)), $argv[3]);`, enc, FX.appKey256, cipher);
      expect(out).toBe("from miu ü");
    }
  });
});
