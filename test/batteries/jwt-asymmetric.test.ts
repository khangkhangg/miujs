import { describe, expect, test } from "bun:test";
import * as nodeCrypto from "node:crypto"; // test-only: cross-check against an independent implementation
import {
  createLocalJwks,
  createRemoteJwks,
  importJwtKey,
  signJwt,
  verifyJwt,
  type JwtAlgorithm,
} from "../../src/batteries/auth/jwt.ts";
import { HttpError } from "../../src/core/errors.ts";

// Generated with Python cryptography 50 + PyJWT 2.14 (jwt.encode). Claims: sub/iat/exp/aud/iss below.
const T0 = 1_700_000_000_000;
const now = () => T0 + 1000;
const PY = {
  "ed": {
    "alg": "EdDSA",
    "publicPem": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAA6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=\n-----END PUBLIC KEY-----\n",
    "token": "eyJhbGciOiJFZERTQSIsImtpZCI6ImVkLTEiLCJ0eXAiOiJKV1QifQ.eyJzdWIiOiJweS11c2VyIiwiaWF0IjoxNzAwMDAwMDAwLCJleHAiOjE3MDAwMDM2MDAsImF1ZCI6Im1pdSIsImlzcyI6InB5and0In0.sjda9iy_BXmlo4M6gddUqBgwumTQTiQhYMjumsgaFP6Tq8vqNhraV8FW_RBNoWhSjkWTgfTg8_JXejJJfsOADQ",
    "jwk": {
      "x": "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg",
      "kty": "OKP",
      "crv": "Ed25519"
    }
  },
  "ec": {
    "alg": "ES256",
    "publicPem": "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAERxw+dYxJBChbun5TEY7Q9SSt6wdX\n0lvS+Oew1236cUzdUg96yoqLkXrMN/Ud6PDJu+OthYOC5wLcJaEtCfeoWA==\n-----END PUBLIC KEY-----\n",
    "token": "eyJhbGciOiJFUzI1NiIsImtpZCI6ImVjLTEiLCJ0eXAiOiJKV1QifQ.eyJzdWIiOiJweS11c2VyIiwiaWF0IjoxNzAwMDAwMDAwLCJleHAiOjE3MDAwMDM2MDAsImF1ZCI6Im1pdSIsImlzcyI6InB5and0In0.1TEI0BXFm2o_sNzHsDfiGxHGiEFuOEJtQiItw8v6JLopvB5JV-ZEU5E2vOB1E3l_7Pf4Dbp8BGCfdQZoxOujfA",
    "jwk": {
      "kty": "EC",
      "crv": "P-256",
      "x": "Rxw-dYxJBChbun5TEY7Q9SSt6wdX0lvS-Oew1236cUw",
      "y": "3VIPesqKi5F6zDf1HejwybvjrYWDgucC3CWhLQn3qFg"
    }
  },
  "rsa": {
    "alg": "RS256",
    "publicPem": "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArr1Uzj7KGbjeXI9FTmoT\neUBabqo8pB2lHwD2NkOFWqW+Fs+5qOoqjhRjtR0Wakz+zZivm1XlInUmgmuIATaw\nDGIUcAfOyHCkPkTxcDk+fRiH0XKkQUvHwxzF+CQ64EjylY06U9iZcF3oOAJ4KdxU\nSZHb3IWpvVSywBcJQemv55hDzEICaI9RdbkHl7NzETRqhe5/h1Zg6a/zGVJA3GSc\nWnsIeKCaB+1gFsqdYV9ApirOeWKZuwjCo4XTaknkZVOJ3YowSfeD8GEbSiY/ZIik\nguGEI1qgSex70Kp9u0Sxsajok6qSr3O2L0j5MBf2qv5RYh/zGWG8nEAPVsKHpxsV\nOQIDAQAB\n-----END PUBLIC KEY-----\n",
    "token": "eyJhbGciOiJSUzI1NiIsImtpZCI6InJzYS0xIiwidHlwIjoiSldUIn0.eyJzdWIiOiJweS11c2VyIiwiaWF0IjoxNzAwMDAwMDAwLCJleHAiOjE3MDAwMDM2MDAsImF1ZCI6Im1pdSIsImlzcyI6InB5and0In0.MQNEMY88cQIhKCENPyYJLQGTJBHHZV10yC7rPM18XZquc36cRQTTx_HAxSc7P-0uEpF6-PCLLC82xwdMGoYI5HWAq7sVBThlbJv18xuGjX6LvCBnyozQ8uvgCAEMbW6dlB8Stv3Y8B0WlNNR5Doy-So7Iv6rszGTPG9vB58uOqvrQxncYdyG_TQBAde2CWJOMTrOhyxX8PzwpqpBFPOPFGlvk5V1o8kh5pcyKpnVstHdd2HrNp2IE9A6zpWgB3wll1dmksjh51ASl4xE0aMokC8YZnPuSX35oWklgLicg8-eRbLBvmSVSkOQoOFiE9xikq1BUDXNUCPrUv1_uSqwvg",
    "jwk": {
      "kty": "RSA",
      "key_ops": [
        "verify"
      ],
      "n": "rr1Uzj7KGbjeXI9FTmoTeUBabqo8pB2lHwD2NkOFWqW-Fs-5qOoqjhRjtR0Wakz-zZivm1XlInUmgmuIATawDGIUcAfOyHCkPkTxcDk-fRiH0XKkQUvHwxzF-CQ64EjylY06U9iZcF3oOAJ4KdxUSZHb3IWpvVSywBcJQemv55hDzEICaI9RdbkHl7NzETRqhe5_h1Zg6a_zGVJA3GScWnsIeKCaB-1gFsqdYV9ApirOeWKZuwjCo4XTaknkZVOJ3YowSfeD8GEbSiY_ZIikguGEI1qgSex70Kp9u0Sxsajok6qSr3O2L0j5MBf2qv5RYh_zGWG8nEAPVsKHpxsVOQ",
      "e": "AQAB"
    }
  }
};

const b64url = (b: Uint8Array | string) =>
  Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const part = (o: unknown) => b64url(JSON.stringify(o));

async function expectInvalid(p: Promise<unknown>, match?: RegExp) {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(401);
    expect((err as HttpError).code).toBe("invalid_token");
    if (match) expect((err as HttpError).message).toMatch(match);
    return;
  }
  throw new Error("expected verifyJwt to throw");
}

type Pair = { privateKey: nodeCrypto.KeyObject; publicKey: nodeCrypto.KeyObject };
const nodePairs: Record<Exclude<JwtAlgorithm, "HS256" | "Ed25519">, () => Pair> = {
  EdDSA: () => nodeCrypto.generateKeyPairSync("ed25519"),
  ES256: () => nodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" }),
  RS256: () => nodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 }),
};
const pem = (k: nodeCrypto.KeyObject) =>
  k.type === "public" ? (k.export({ type: "spki", format: "pem" }) as string) : (k.export({ type: "pkcs8", format: "pem" }) as string);
const jwk = (k: nodeCrypto.KeyObject) => k.export({ format: "jwk" }) as JsonWebKey;

/** Sign with node:crypto (an independent JWS implementation). */
function nodeSign(alg: JwtAlgorithm, key: nodeCrypto.KeyObject, payload: object, header: object = {}) {
  const input = `${part({ alg, typ: "JWT", ...header })}.${part(payload)}`;
  const data = Buffer.from(input);
  const sig =
    alg === "EdDSA"
      ? nodeCrypto.sign(null, data, key)
      : alg === "ES256"
        ? nodeCrypto.sign("sha256", data, { key, dsaEncoding: "ieee-p1363" })
        : nodeCrypto.sign("sha256", data, key);
  return `${input}.${b64url(sig)}`;
}

function nodeVerify(alg: JwtAlgorithm, key: nodeCrypto.KeyObject, token: string) {
  const [h, p, s] = token.split(".") as [string, string, string];
  const data = Buffer.from(`${h}.${p}`);
  const sig = Buffer.from(s, "base64url");
  if (alg === "EdDSA") return nodeCrypto.verify(null, data, key, sig);
  if (alg === "ES256") return nodeCrypto.verify("sha256", data, { key, dsaEncoding: "ieee-p1363" }, sig);
  return nodeCrypto.verify("sha256", data, key, sig);
}

const ASYM: Exclude<JwtAlgorithm, "HS256" | "Ed25519">[] = ["EdDSA", "ES256", "RS256"];
const PY_BY_ALG = { EdDSA: PY.ed, ES256: PY.ec, RS256: PY.rsa };

describe("JWT: PyJWT-generated tokens", () => {
  for (const alg of ASYM) {
    const fx = PY_BY_ALG[alg];
    test(`${alg}: verifies with a PEM (SPKI) key`, async () => {
      const p = await verifyJwt(fx.token, fx.publicPem, { algorithms: [alg], audience: "miu", issuer: "pyjwt", now });
      expect(p).toMatchObject({ sub: "py-user", aud: "miu" });
    });
    test(`${alg}: verifies with a JWK and an imported CryptoKey`, async () => {
      await verifyJwt(fx.token, fx.jwk as JsonWebKey, { algorithms: [alg], now });
      const key = await importJwtKey(fx.publicPem, alg);
      expect(key.type).toBe("public");
      await verifyJwt(fx.token, key, { algorithms: [alg], now });
    });
    test(`${alg}: rejects a tampered payload`, async () => {
      const [h, , s] = fx.token.split(".");
      const forged = `${h}.${part({ sub: "admin", aud: "miu" })}.${s}`;
      await expectInvalid(verifyJwt(forged, fx.publicPem, { algorithms: [alg], now }), /signature/);
    });
  }

  test("the algorithm allow-list is enforced even when the key would fit", async () => {
    await expectInvalid(verifyJwt(PY.ed.token, PY.ed.publicPem, { algorithms: ["ES256"], now }), /alg/);
  });

  test("a key of the wrong type is rejected", async () => {
    await expectInvalid(verifyJwt(PY.ed.token, PY.ec.publicPem, { algorithms: ["EdDSA", "ES256"], now }));
    await expectInvalid(verifyJwt(PY.rsa.token, PY.ec.jwk as JsonWebKey, { algorithms: ["RS256"], now }));
  });
});

describe("JWT: node:crypto cross-check", () => {
  for (const alg of ASYM) {
    test(`${alg}: node:crypto-signed tokens verify (PEM, JWK)`, async () => {
      const { privateKey, publicKey } = nodePairs[alg]();
      const token = nodeSign(alg, privateKey, { sub: "n1", exp: T0 / 1000 + 60 });
      expect(await verifyJwt(token, pem(publicKey), { algorithms: [alg], now })).toMatchObject({ sub: "n1" });
      expect(await verifyJwt(token, jwk(publicKey), { algorithms: [alg], now })).toMatchObject({ sub: "n1" });
    });

    test(`${alg}: Miu-signed tokens verify with node:crypto (PKCS8 PEM and private JWK)`, async () => {
      const { privateKey, publicKey } = nodePairs[alg]();
      const t1 = await signJwt({ sub: "m1" }, pem(privateKey), { algorithm: alg, kid: "k1", expiresIn: 60, now: () => T0 });
      const t2 = await signJwt({ sub: "m2" }, jwk(privateKey), { algorithm: alg });
      expect(nodeVerify(alg, publicKey, t1)).toBe(true);
      expect(nodeVerify(alg, publicKey, t2)).toBe(true);
      const header = JSON.parse(Buffer.from(t1.split(".")[0]!, "base64url").toString());
      expect(header).toEqual({ alg, typ: "JWT", kid: "k1" });
      expect(await verifyJwt(t1, pem(publicKey), { algorithms: [alg], now })).toMatchObject({ sub: "m1", exp: T0 / 1000 + 60 });
    });
  }

  test("ES256 rejects DER-encoded signatures (JWS needs raw r||s)", async () => {
    const { privateKey, publicKey } = nodePairs.ES256();
    const input = `${part({ alg: "ES256" })}.${part({ sub: "x" })}`;
    const der = nodeCrypto.sign("sha256", Buffer.from(input), privateKey);
    await expectInvalid(verifyJwt(`${input}.${b64url(der)}`, pem(publicKey), { algorithms: ["ES256"] }));
  });

  test("RSA keys under 2048 bits are refused", async () => {
    const { privateKey, publicKey } = nodeCrypto.generateKeyPairSync("rsa", { modulusLength: 1024 });
    const token = nodeSign("RS256", privateKey, { sub: "weak" });
    await expectInvalid(verifyJwt(token, pem(publicKey), { algorithms: ["RS256"] }), /2048/);
  });
});

describe("JWT: algorithm confusion", () => {
  test("an RS256 public key is never accepted as an HS256 secret", async () => {
    // Classic attack: HMAC-sign with the public key's PEM text and claim alg=HS256.
    const input = `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub: "admin" })}`;
    const hmac = nodeCrypto.createHmac("sha256", PY.rsa.publicPem).update(input).digest();
    const attack = `${input}.${b64url(hmac)}`;
    await expectInvalid(verifyJwt(attack, PY.rsa.publicPem, { algorithms: ["RS256", "HS256"] }));
    await expectInvalid(verifyJwt(attack, PY.rsa.publicPem, { algorithms: ["RS256"] }), /alg/);
    await expectInvalid(verifyJwt(attack, PY.rsa.jwk as JsonWebKey, { algorithms: ["RS256", "HS256"] }));
    const jwkHmac = nodeCrypto.createHmac("sha256", JSON.stringify(PY.rsa.jwk)).update(input).digest();
    await expectInvalid(verifyJwt(`${input}.${b64url(jwkHmac)}`, PY.rsa.jwk as JsonWebKey, { algorithms: ["HS256"] }));
  });

  test("asymmetric keys require an explicit algorithms allow-list", async () => {
    await expect(verifyJwt(PY.ed.token, PY.ed.publicPem)).rejects.toThrow(/algorithms/);
    await expect(verifyJwt(PY.ed.token, PY.ed.jwk as JsonWebKey)).rejects.toThrow(/algorithms/);
  });

  test("an HS256 secret cannot verify an EdDSA token, and alg none is refused", async () => {
    await expectInvalid(verifyJwt(PY.ed.token, "secret-secret-secret-secret-secret"), /alg/);
    const none = `${part({ alg: "none" })}.${part({ sub: "x" })}.`;
    await expectInvalid(verifyJwt(none, PY.ed.publicPem, { algorithms: ["EdDSA"] }), /alg/);
  });

  test("tokens with a crit header are rejected", async () => {
    const { privateKey, publicKey } = nodePairs.EdDSA();
    const token = nodeSign("EdDSA", privateKey, { sub: "x" }, { crit: ["exp"] });
    await expectInvalid(verifyJwt(token, pem(publicKey), { algorithms: ["EdDSA"] }), /crit/);
  });

  test("a private key passed to verifyJwt is rejected; signing needs a private key", async () => {
    const { privateKey, publicKey } = nodePairs.EdDSA();
    const token = nodeSign("EdDSA", privateKey, { sub: "x" });
    await expect(verifyJwt(token, pem(privateKey), { algorithms: ["EdDSA"] })).rejects.toThrow(/public/);
    await expect(signJwt({ sub: "x" }, pem(publicKey), { algorithm: "EdDSA" })).rejects.toThrow(/private/);
    await expect(signJwt({ sub: "x" }, pem(privateKey))).rejects.toThrow(/algorithm/);
  });

  test("unsupported PEM types fail with a clear message", async () => {
    const rsaPkcs1 = nodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "pkcs1", format: "pem" }) as string;
    await expect(verifyJwt(PY.rsa.token, rsaPkcs1, { algorithms: ["RS256"] })).rejects.toThrow(/RSA PUBLIC KEY/);
  });

  test("HS256 still works with string secrets, and with an explicit allow-list", async () => {
    const token = await signJwt({ sub: "h" }, "s".repeat(40), { algorithm: "HS256" });
    expect(await verifyJwt(token, "s".repeat(40), { algorithms: ["HS256"] })).toMatchObject({ sub: "h" });
    await expectInvalid(verifyJwt(token, "s".repeat(40), { algorithms: ["EdDSA"] }), /alg/);
  });
});

describe("JWKS", () => {
  const setup = () => {
    const a = nodePairs.EdDSA();
    const b = nodePairs.ES256();
    const pubA = { ...jwk(a.publicKey), kid: "a", use: "sig", alg: "EdDSA" };
    const pubB = { ...jwk(b.publicKey), kid: "b" };
    return { a, b, pubA, pubB };
  };

  test("local JWKS selects the key by kid", async () => {
    const { a, b, pubA, pubB } = setup();
    const jwks = createLocalJwks({ keys: [pubA, pubB] });
    const ta = nodeSign("EdDSA", a.privateKey, { sub: "a" }, { kid: "a" });
    const tb = nodeSign("ES256", b.privateKey, { sub: "b" }, { kid: "b" });
    expect(await verifyJwt(ta, jwks, { algorithms: ["EdDSA", "ES256"] })).toMatchObject({ sub: "a" });
    expect(await verifyJwt(tb, jwks, { algorithms: ["EdDSA", "ES256"] })).toMatchObject({ sub: "b" });
    // a plain { keys } object works too
    expect(await verifyJwt(ta, { keys: [pubA, pubB] }, { algorithms: ["EdDSA"] })).toMatchObject({ sub: "a" });
    // kid pointing at a key of another type
    const wrong = nodeSign("EdDSA", a.privateKey, { sub: "a" }, { kid: "b" });
    await expectInvalid(verifyJwt(wrong, jwks, { algorithms: ["EdDSA", "ES256"] }), /key/i);
    // unknown kid
    await expectInvalid(verifyJwt(nodeSign("EdDSA", a.privateKey, {}, { kid: "zzz" }), jwks, { algorithms: ["EdDSA"] }), /key/i);
    // keys marked for encryption are ignored
    const enc = createLocalJwks({ keys: [{ ...pubA, use: "enc" }] });
    await expectInvalid(verifyJwt(ta, enc, { algorithms: ["EdDSA"] }), /key/i);
  });

  test("without kid, a single matching key is used; several are ambiguous", async () => {
    const { a, pubA, pubB } = setup();
    const token = nodeSign("EdDSA", a.privateKey, { sub: "a" });
    expect(await verifyJwt(token, { keys: [pubA, pubB] }, { algorithms: ["EdDSA"] })).toMatchObject({ sub: "a" });
    const other = { ...jwk(nodePairs.EdDSA().publicKey), kid: "c" };
    await expectInvalid(verifyJwt(token, { keys: [pubA, other] }, { algorithms: ["EdDSA"] }), /key/i);
  });

  test("JWKS never yields a symmetric key for HS256 unless one is listed", async () => {
    const { pubA } = setup();
    const input = `${part({ alg: "HS256", kid: "a" })}.${part({ sub: "admin" })}`;
    const sig = nodeCrypto.createHmac("sha256", JSON.stringify(pubA)).update(input).digest();
    await expectInvalid(verifyJwt(`${input}.${b64url(sig)}`, { keys: [pubA] }, { algorithms: ["HS256", "EdDSA"] }), /key/i);
  });

  test("remote JWKS caches, refreshes on unknown kid (with cooldown) and after cacheTtl", async () => {
    const { a, pubA } = setup();
    const c = nodePairs.EdDSA();
    const pubC = { ...jwk(c.publicKey), kid: "c" };
    let keys: JsonWebKey[] = [pubA];
    let fetches = 0;
    let t = T0;
    const fetchFn = (async (input: RequestInfo | URL) => {
      fetches++;
      expect(String(input)).toBe("https://issuer.example/.well-known/jwks.json");
      return Response.json({ keys });
    }) as typeof fetch;
    const jwks = createRemoteJwks("https://issuer.example/.well-known/jwks.json", { fetch: fetchFn, cacheTtl: 600, cooldown: 30, now: () => t });
    const ta = nodeSign("EdDSA", a.privateKey, { sub: "a" }, { kid: "a" });
    const tc = nodeSign("EdDSA", c.privateKey, { sub: "c" }, { kid: "c" });
    const opts = { algorithms: ["EdDSA"] as JwtAlgorithm[], now: () => t };

    await Promise.all([verifyJwt(ta, jwks, opts), verifyJwt(ta, jwks, opts)]);
    expect(fetches).toBe(1); // concurrent loads are shared
    await verifyJwt(ta, jwks, opts);
    expect(fetches).toBe(1);

    // key rotation: unknown kid triggers one refresh
    keys = [pubA, pubC];
    t += 31_000;
    expect(await verifyJwt(tc, jwks, opts)).toMatchObject({ sub: "c" });
    expect(fetches).toBe(2);

    // unknown kid within the cooldown does not refetch (no amplification by attackers)
    const td = nodeSign("EdDSA", nodePairs.EdDSA().privateKey, {}, { kid: "d" });
    await expectInvalid(verifyJwt(td, jwks, opts), /key/i);
    expect(fetches).toBe(2);

    // cache expiry
    t += 601_000;
    await verifyJwt(ta, jwks, opts);
    expect(fetches).toBe(3);
  });

  test("remote JWKS: serves stale keys when a refresh fails, errors when it has none", async () => {
    const { a, pubA } = setup();
    let fail = false;
    let t = T0;
    const fetchFn = (async () => (fail ? new Response("down", { status: 500 }) : Response.json({ keys: [pubA] }))) as unknown as typeof fetch;
    const jwks = createRemoteJwks("https://issuer.example/jwks", { fetch: fetchFn, cacheTtl: 10, now: () => t });
    const ta = nodeSign("EdDSA", a.privateKey, { sub: "a" }, { kid: "a" });
    await verifyJwt(ta, jwks, { algorithms: ["EdDSA"] });
    fail = true;
    t += 60_000;
    await verifyJwt(ta, jwks, { algorithms: ["EdDSA"] });

    const broken = createRemoteJwks("https://issuer.example/jwks", { fetch: fetchFn });
    const err = await verifyJwt(ta, broken, { algorithms: ["EdDSA"] }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(503);
  });

  test("remote JWKS requires https (except localhost)", () => {
    expect(() => createRemoteJwks("http://issuer.example/jwks")).toThrow(/https/);
    expect(() => createRemoteJwks("http://localhost:8080/jwks")).not.toThrow();
  });
});

describe("JWT: live PyJWT cross-check", () => {
  const py = Bun.spawnSync(["python3", "-I", "-c", "import jwt, cryptography"]);
  test.skipIf(py.exitCode !== 0)("PyJWT verifies Miu-signed EdDSA, ES256 and RS256 tokens", async () => {
    for (const alg of ASYM) {
      const { privateKey, publicKey } = nodePairs[alg]();
      const token = await signJwt({ sub: "miu", aud: "py" }, pem(privateKey), { algorithm: alg });
      const script = "import sys, jwt; print(jwt.decode(sys.argv[1], sys.argv[2], algorithms=[sys.argv[3]], audience='py')['sub'])";
      const r = Bun.spawnSync(["python3", "-I", "-c", script, token, pem(publicKey), alg]);
      expect({ alg, out: r.stdout.toString().trim(), err: r.stderr.toString() }).toEqual({ alg, out: "miu", err: "" });
    }
  });
});
