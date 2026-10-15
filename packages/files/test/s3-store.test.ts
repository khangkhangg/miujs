import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { s3Store, type S3StoreOptions } from "../src/s3.ts";
import { collect, toStream } from "../src/stream.ts";
import { fakeS3 } from "./fake-s3.ts";
import { str } from "./fixtures.ts";
import { storeSuite } from "./store-suite.ts";

const creds = { accessKeyId: "AKIDTEST", secretAccessKey: "very-secret-key/with+chars" };
const server = fakeS3({ ...creds, region: "eu-central-1" });
afterAll(() => server.stop());

let n = 0;
function store(extra: Partial<S3StoreOptions> = {}) {
  const bucket = `bucket-${++n}`;
  server.createBucket(bucket);
  return s3Store({ endpoint: server.url, region: "eu-central-1", bucket, ...creds, forcePathStyle: true, ...extra });
}

describe("s3Store against a signature-checking fake S3", () => {
  storeSuite(() => store());

  test("keys with spaces, unicode and reserved characters round-trip", async () => {
    const st = store();
    const key = "dir with space/ü & (x)+y=z!'*~.txt";
    await st.put(key, toStream("v"), { contentType: "text/plain" });
    expect(str(await collect((await st.get(key))!.body))).toBe("v");
    expect((await st.list({ prefix: "dir with" })).files.map((f) => f.key)).toEqual([key]);
    await st.delete(key);
    expect(await st.head(key)).toBeNull();
  });

  test("a range past the end reads nothing", async () => {
    const st = store();
    await st.put("r", toStream("abc"));
    const got = (await st.get("r", { range: { offset: 10, length: 5 } }))!;
    expect(got.size).toBe(3);
    expect(got.range).toEqual({ offset: 10, length: 0 });
    expect((await collect(got.body)).byteLength).toBe(0);
  });

  test("multipart errors map to the files error codes", async () => {
    const st = store();
    await expect(st.uploadPart("k", "nope", 1, toStream("x"), 1)).rejects.toMatchObject({ code: "MIU_E_FILES_UPLOAD_NOT_FOUND" });
    const id = await st.createMultipart("k");
    await st.uploadPart("k", id, 1, toStream("x"), 1);
    await expect(st.completeMultipart("k", id, [{ partNumber: 1, etag: "bogus" }])).rejects.toMatchObject({ code: "MIU_E_FILES_PART_INVALID" });
    await st.abortMultipart("k", id);
    await st.abortMultipart("k", id); // already gone: no error, like r2Store
  });

  test("wrong credentials fail with MIU_E_FILES_S3 naming S3's code, and never echo the secret", async () => {
    const st = store({ secretAccessKey: "wrong-secret-value" });
    const err = await st.put("k", toStream("x")).catch((e) => e);
    expect(err.code).toBe("MIU_E_FILES_S3");
    expect(err.message).toContain("SignatureDoesNotMatch");
    expect(err.fix).toContain("S3_SECRET_ACCESS_KEY");
    expect(JSON.stringify({ m: err.message, f: err.fix, d: err.details })).not.toContain("wrong-secret-value");
    const err2 = await store({ region: "us-west-2" }).head("k").catch((e) => e);
    expect(err2.code).toBe("MIU_E_FILES_S3");
  });

  test("a missing bucket is MIU_E_FILES_S3 with a fix", async () => {
    const st = s3Store({ endpoint: server.url, region: "eu-central-1", bucket: "does-not-exist", ...creds, forcePathStyle: true });
    const err = await st.list().catch((e) => e);
    expect(err.code).toBe("MIU_E_FILES_S3");
    expect(err.message).toContain("NoSuchBucket");
    expect(err.fix).toContain("does-not-exist");
  });

  test("the secret never appears in any request", async () => {
    const st = store();
    const before = server.requests.length;
    await st.put("a", toStream("1"), { metadata: { k: "v" } });
    await st.get("a");
    for (const r of server.requests.slice(before)) expect(JSON.stringify(r)).not.toContain(creds.secretAccessKey);
  });
});

describe("s3Store configuration", () => {
  const ENV = ["S3_ENDPOINT", "S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "MY_KEY", "MY_SECRET"];
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("everything can come from S3_* env vars", async () => {
    server.createBucket("from-env");
    Object.assign(process.env, { S3_ENDPOINT: server.url, S3_REGION: "eu-central-1", S3_BUCKET: "from-env", S3_ACCESS_KEY_ID: creds.accessKeyId, S3_SECRET_ACCESS_KEY: creds.secretAccessKey });
    const st = s3Store({ forcePathStyle: true });
    await st.put("e", toStream("env"));
    expect(str(await collect((await st.get("e"))!.body))).toBe("env");
  });

  test("credentials can name other env vars, resolved per request env (Workers secrets)", async () => {
    server.createBucket("named");
    const st = s3Store({ endpoint: server.url, region: "eu-central-1", bucket: "named", accessKeyId: { env: "MY_KEY" }, secretAccessKey: { env: "MY_SECRET" }, forcePathStyle: true });
    const bound = st.forEnv!({ MY_KEY: creds.accessKeyId, MY_SECRET: creds.secretAccessKey });
    await bound.put("w", toStream("worker"));
    expect(server.buckets.get("named")!.has("w")).toBe(true);
    expect(st.forEnv!({ MY_KEY: creds.accessKeyId, MY_SECRET: creds.secretAccessKey })).not.toBe(st); // a concrete store
  });

  test("missing settings fail with MIU_E_FILES_S3_CONFIG naming the env vars, not values", async () => {
    for (const k of ENV) delete process.env[k];
    const st = s3Store({ endpoint: "https://s3.example.com", bucket: "b", accessKeyId: { env: "MY_KEY" } });
    const err = await st.head("k").catch((e) => e);
    expect(err.code).toBe("MIU_E_FILES_S3_CONFIG");
    expect(err.message).toContain("MY_KEY");
    expect(err.fix).toContain("S3_SECRET_ACCESS_KEY");
    expect(() => s3Store({ endpoint: "not a url", bucket: "b", ...creds }).forEnv!({})).toThrow(expect.objectContaining({ code: "MIU_E_FILES_S3_CONFIG" }) as any);
  });

  test("virtual-hosted URLs by default; path style on request", async () => {
    const urls: string[] = [];
    const fetch = (async (input: Request | string) => {
      urls.push(typeof input === "string" ? input : input.url);
      return new Response(null, { status: 404 });
    }) as typeof globalThis.fetch;
    const base = { endpoint: "https://s3.us-east-1.amazonaws.com", region: "us-east-1", bucket: "my-bucket", ...creds, fetch };
    await s3Store(base).head("a b/c.txt");
    await s3Store({ ...base, forcePathStyle: true }).head("a b/c.txt");
    // Keys go out encoded exactly as they are signed (RFC 3986, like the AWS SDKs).
    await s3Store(base).head("x/it's (1)*!.txt");
    expect(urls).toEqual([
      "https://my-bucket.s3.us-east-1.amazonaws.com/a%20b/c.txt",
      "https://s3.us-east-1.amazonaws.com/my-bucket/a%20b/c.txt",
      "https://my-bucket.s3.us-east-1.amazonaws.com/x/it%27s%20%281%29%2A%21.txt",
    ]);
  });

  test("inspect shows where, never credentials", () => {
    const st = s3Store({ endpoint: "https://acct.r2.cloudflarestorage.com", region: "auto", bucket: "b", ...creds });
    const info = st.inspect!();
    expect(info).toEqual({ endpoint: "https://acct.r2.cloudflarestorage.com", region: "auto", bucket: "b", forcePathStyle: false, credentials: "inline" });
    expect(JSON.stringify(info)).not.toContain(creds.secretAccessKey);
    expect(s3Store({ accessKeyId: { env: "MY_KEY" } }).inspect!().credentials).toBe("env MY_KEY / S3_SECRET_ACCESS_KEY");
  });
});
