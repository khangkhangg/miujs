import { describe, expect, test } from "bun:test";
import { encodeRfc3986, sha256Hex, signV4 } from "../src/sigv4.ts";

// AWS Signature Version 4 test suite (aws-sig-v4-test-suite, "get-vanilla" family):
// service "service", region us-east-1, 2015-08-30T12:36:00Z, the example credentials below.
const suite = {
  region: "us-east-1",
  service: "service",
  credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" },
  date: new Date(Date.UTC(2015, 7, 30, 12, 36, 0)),
  payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
};

const vanilla = (path: string) => signV4({ ...suite, method: "GET", url: `https://example.amazonaws.com${path}`, headers: {} });

describe("SigV4 against AWS test vectors", () => {
  test("get-vanilla: canonical request, string to sign, signature, Authorization", async () => {
    const s = await vanilla("/");
    expect(s.canonicalRequest).toBe(
      ["GET", "/", "", "host:example.amazonaws.com", "x-amz-date:20150830T123600Z", "", "host;x-amz-date", suite.payloadHash].join("\n"),
    );
    expect(s.stringToSign).toBe(
      ["AWS4-HMAC-SHA256", "20150830T123600Z", "20150830/us-east-1/service/aws4_request", "bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63"].join("\n"),
    );
    expect(s.signature).toBe("5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
    expect(s.headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
    expect(s.headers["x-amz-date"]).toBe("20150830T123600Z");
  });

  const vectors: [string, string, string][] = [
    ["get-vanilla-query", "/", "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"],
    ["get-vanilla-empty-query-key", "/?Param1=value1", "a67d582fa61cc504c4bae71f336f98b97f1ea3c7a6bfe1b6e45aec72011b9aeb"],
    ["get-vanilla-query-order-key-case", "/?Param2=value2&Param1=value1", "b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500"],
    ["get-vanilla-query-order-key", "/?Param1=value2&Param1=Value1", "eedbc4e291e521cf13422ffca22be7d2eb8146eecf653089df300a15b2382bd1"],
    ["get-vanilla-query-order-value", "/?Param1=value2&Param1=value1", "5772eed61e12b33fae39ee5e7012498b51d56abc0abb7c60486157bd471c4694"],
    [
      "get-vanilla-query-unreserved",
      "/?-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz=-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
      "9c3e54bfcdf0b19771a7f523ee5669cdf59bc7cc0884027167c21bb143a40197",
    ],
    ["get-vanilla-utf8-query", "/?ሴ=bar", "2cdec8eed098649ff3a119c94853b13c643bcf08f8b0a1d91e12c9027818dd04"],
  ];
  for (const [name, path, signature] of vectors) {
    test(name, async () => {
      expect((await vanilla(path)).signature).toBe(signature);
    });
  }

  test("S3 docs example: GET Object with a Range header", async () => {
    const s = await signV4({
      method: "GET",
      url: "https://examplebucket.s3.amazonaws.com/test.txt",
      headers: { range: "bytes=0-9", "x-amz-content-sha256": suite.payloadHash },
      payloadHash: suite.payloadHash,
      region: "us-east-1",
      service: "s3",
      credentials: { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
      date: new Date(Date.UTC(2013, 4, 24)),
    });
    expect(s.headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41".replace(
        /,(?=S)/g,
        ", ",
      ),
    );
  });
});

describe("SigV4 details", () => {
  test("a session token is sent and signed as x-amz-security-token", async () => {
    const s = await signV4({ ...suite, credentials: { ...suite.credentials, sessionToken: "tok" }, method: "GET", url: "https://h/", headers: {} });
    expect(s.headers["x-amz-security-token"]).toBe("tok");
    expect(s.headers.authorization).toContain("SignedHeaders=host;x-amz-date;x-amz-security-token,");
  });

  test("header values are trimmed and inner spaces collapsed; names lowercased and sorted", async () => {
    const s = await signV4({ ...suite, method: "GET", url: "https://h/", headers: { "X-Custom": "  a   b  ", Accept: "x" } });
    expect(s.canonicalRequest.split("\n").slice(3, 7)).toEqual(["accept:x", "host:h", "x-amz-date:20150830T123600Z", "x-custom:a b"]);
  });

  test("the path is encoded once (S3 style), segment by segment", async () => {
    const s = await signV4({ ...suite, method: "GET", url: "https://h/a%20b/c!(d)*", headers: {} });
    expect(s.canonicalRequest.split("\n")[1]).toBe("/a%20b/c%21%28d%29%2A");
  });

  test("encodeRfc3986 and sha256Hex", async () => {
    expect(encodeRfc3986("a b/~!*'()")).toBe("a%20b%2F~%21%2A%27%28%29");
    expect(await sha256Hex(new Uint8Array())).toBe(suite.payloadHash);
  });
});
