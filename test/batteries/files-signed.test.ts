import { describe, expect, test } from "bun:test";
import { Miu } from "../../src/core/app.ts";
import { memoryBlobStore, signBlobUrl, signedBlobs, verifySignedBlobUrl } from "../../src/batteries/files/index.ts";

const secret = "s".repeat(32);
const other = "o".repeat(32);
const now = 1_700_000_000_000;

describe("signBlobUrl / verifySignedBlobUrl", () => {
  test("round-trips a key (with encoded segments) before expiry", async () => {
    const url = await signBlobUrl("tours/t 1/pano#1.jpg", { secret, expiresIn: 60, now });
    expect(url).toStartWith("/files/tours/t%201/pano%231.jpg?exp=1700000060&sig=");
    expect(await verifySignedBlobUrl(url, secret, now)).toBe("tours/t 1/pano#1.jpg");
    expect(await verifySignedBlobUrl(`https://cdn.example${url}`, secret, now + 59_000)).toBe("tours/t 1/pano#1.jpg");
  });

  test("rejects expired, tampered key/exp/sig and the wrong secret", async () => {
    const url = await signBlobUrl("a/b.jpg", { secret, expiresIn: 60, now });
    expect(await verifySignedBlobUrl(url, secret, now + 60_000)).toBeUndefined();
    expect(await verifySignedBlobUrl(url.replace("a/b.jpg", "a/c.jpg"), secret, now)).toBeUndefined();
    expect(await verifySignedBlobUrl(url.replace("exp=1700000060", "exp=1800000060"), secret, now)).toBeUndefined();
    const sig = new URL(url, "http://x").searchParams.get("sig")!;
    const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    expect(await verifySignedBlobUrl(url.replace(sig, flipped), secret, now)).toBeUndefined();
    expect(await verifySignedBlobUrl(url.replace(sig, sig.slice(0, -2)), secret, now)).toBeUndefined();
    expect(await verifySignedBlobUrl(url, other, now)).toBeUndefined();
    expect(await verifySignedBlobUrl("/files/a/b.jpg", secret, now)).toBeUndefined();
    expect(await verifySignedBlobUrl("/elsewhere/a/b.jpg?exp=1&sig=x", secret, now)).toBeUndefined();
  });

  test("signature is bound to the method", async () => {
    const url = await signBlobUrl("a", { secret, expiresIn: 60, now, method: "PUT" });
    expect(await verifySignedBlobUrl(url, secret, now)).toBeUndefined();
    expect(await verifySignedBlobUrl(url, secret, now, { method: "PUT" })).toBe("a");
  });

  test("refuses weak secrets, bad expiry and unsafe keys", async () => {
    await expect(signBlobUrl("a", { secret: "short", expiresIn: 60 })).rejects.toThrow();
    await expect(signBlobUrl("a", { secret, expiresIn: 0 })).rejects.toThrow();
    await expect(signBlobUrl("../a", { secret, expiresIn: 60 })).rejects.toThrow();
  });
});

describe("signedBlobs middleware", () => {
  const setup = async () => {
    const store = memoryBlobStore();
    await store.put("tours/t1/pano.jpg", "panorama-bytes", { contentType: "image/jpeg" });
    const app = new Miu({ logger: false }).use(signedBlobs({ store, secret })).get("/other", () => "other");
    return { store, app };
  };

  test("serves a valid link via serveBlob (ranges, etag) with no-referrer", async () => {
    const { app } = await setup();
    const url = await signBlobUrl("tours/t1/pano.jpg", { secret, expiresIn: 60 });
    const res = await app.request(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("panorama-bytes");
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const part = await app.request(url, { headers: { range: "bytes=0-7" } });
    expect(part.status).toBe(206);
    expect(await part.text()).toBe("panorama");
    expect((await app.request("/other")).status).toBe(200);
  });

  test("403 for expired, tampered or unsigned links; 404 for a valid link to a missing blob", async () => {
    const { app } = await setup();
    const expired = await signBlobUrl("tours/t1/pano.jpg", { secret, expiresIn: 1, now: Date.now() - 5000 });
    const tamperedKey = (await signBlobUrl("tours/t1/pano.jpg", { secret, expiresIn: 60 })).replace("t1", "t2");
    const wrongSecret = await signBlobUrl("tours/t1/pano.jpg", { secret: other, expiresIn: 60 });
    for (const u of [expired, tamperedKey, wrongSecret, "/files/tours/t1/pano.jpg"]) {
      const res = await app.request(u);
      expect(res.status).toBe(403);
      expect(res.headers.get("content-type")).toBe("application/problem+json");
    }
    expect((await app.request(await signBlobUrl("tours/missing.jpg", { secret, expiresIn: 60 }))).status).toBe(404);
  });
});
