import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMiuError } from "miujs";
import { sqlite } from "@miujs/db";
import { anchorHead, anchorJob, canonicalJson, dbAuditStore, fileSink, httpSink, memoryAuditStore, purgeOlderThan, verifyChain, type Anchor, type AuditInput } from "../src/index.ts";

const K1 = "k1-secret-0123456789abcdefghijklmnopqrstuvwxyz";
const K2 = "k2-secret-ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210";
const NOW = 1_800_000_000_000;

function entry(i: number, over: Partial<AuditInput> = {}): AuditInput {
  return { ts: 1_700_000_000_000 + i * 1000, action: "update", resource: "contacts", resourceId: `r${i}`, actor: "alice", metadata: { i }, ...over };
}

function memSink() {
  const puts: [string, string][] = [];
  return { puts, put: async (k: string, v: string) => void puts.push([k, v]) };
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    return isMiuError(e) ? e.code : String(e);
  }
  return undefined;
}

async function sha256Hex(s: string) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function filledDb(n: number, key?: string) {
  const database = sqlite();
  const store = dbAuditStore(database, key ? { key } : {});
  for (let i = 1; i <= n; i++) await store.append(entry(i));
  await database.exec("DROP TRIGGER audit_log_no_update");
  return { database, store };
}

describe("anchorHead", () => {
  test("writes { seq, hash, at, keyId, signature } to the sink under a sortable key", async () => {
    const store = memoryAuditStore({ key: K1 });
    for (let i = 1; i <= 3; i++) await store.append(entry(i));
    const sink = memSink();
    const a = await anchorHead(store, sink, { now: NOW });
    const head = await store.head();
    expect(a).toMatchObject({ seq: 3, hash: head!.hash, at: NOW });
    expect(a!.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(a!.keyId).toBe(head!.keyId!);
    expect(sink.puts.length).toBe(1);
    expect(sink.puts[0][0]).toBe("audit-anchors/000000000000003.json");
    expect(JSON.parse(sink.puts[0][1])).toEqual(a);
  });

  test("an empty log writes nothing", async () => {
    const sink = memSink();
    expect(await anchorHead(memoryAuditStore(), sink)).toBeNull();
    expect(sink.puts).toEqual([]);
  });

  test("without a key the anchor is unsigned", async () => {
    const store = memoryAuditStore();
    await store.append(entry(1));
    const a = await anchorHead(store, memSink());
    expect(a!.signature).toBeNull();
  });

  test("custom prefix", async () => {
    const store = memoryAuditStore();
    await store.append(entry(1));
    const sink = memSink();
    await anchorHead(store, sink, { prefix: "phi/anchors/" });
    expect(sink.puts[0][0]).toBe("phi/anchors/000000000000001.json");
  });

  test("a binding name resolves from env (R2/KV); a missing binding is an error with a fix", async () => {
    const store = memoryAuditStore();
    await store.append(entry(1));
    const bucket = memSink();
    await anchorHead(store, "AUDIT_ANCHORS", { env: { AUDIT_ANCHORS: bucket } });
    expect(bucket.puts.length).toBe(1);
    let err: any;
    try {
      await anchorHead(store, "AUDIT_ANCHORS", { env: {} });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe("MIU_E_AUDIT_SINK_MISSING");
    expect(err.fix).toContain("AUDIT_ANCHORS");
  });
});

describe("verifyChain({ anchors })", () => {
  test("ok against its own anchors", async () => {
    const { store } = await filledDb(5, K1);
    const a = await anchorHead(store, memSink(), { now: NOW });
    expect(await verifyChain(store, { anchors: [a!] })).toEqual({ ok: true, checked: 5 });
  });

  test("detects tail truncation", async () => {
    const { database, store } = await filledDb(5, K1);
    const a = await anchorHead(store, memSink(), { now: NOW });
    await database.prepare("DELETE FROM audit_log WHERE seq >= 4").run();
    expect((await verifyChain(store)).ok).toBe(true); // invisible without anchors
    expect(await verifyChain(store, { anchors: [a!] })).toMatchObject({ ok: false, brokenAt: 4, reason: expect.stringMatching(/truncat|deleted/) });
  });

  test("detects truncation of everything", async () => {
    const { database, store } = await filledDb(3);
    const a = await anchorHead(store, memSink());
    await database.prepare("DELETE FROM audit_log").run();
    expect(await verifyChain(store, { anchors: [a!] })).toMatchObject({ ok: false, brokenAt: 1 });
  });

  test("detects a plain chain rewritten end to end (every hash recomputed)", async () => {
    const { database, store } = await filledDb(5);
    const a = await anchorHead(store, memSink());
    let prev = (await store.scan(0, 1))[0].hash;
    for (const r of await store.scan(1, 10)) {
      const forged = { ...r, actor: r.seq === 2 ? "mallory" : r.actor };
      const { hash: _h, prevHash: _p, ...body } = forged;
      const h = await sha256Hex(prev + canonicalJson(body));
      await database.prepare("UPDATE audit_log SET actor = ?, prev_hash = ?, hash = ? WHERE seq = ?").bind(forged.actor, prev, h, r.seq).run();
      prev = h;
    }
    expect((await verifyChain(store)).ok).toBe(true); // a self-consistent forgery...
    expect(await verifyChain(store, { anchors: [a!] })).toMatchObject({ ok: false, brokenAt: 5 }); // ...caught by the anchor
  });

  test("older anchors still check their row; anchors can be JSON strings", async () => {
    const { store } = await filledDb(3, K1);
    const a1 = await anchorHead(store, memSink(), { now: NOW });
    await store.append(entry(4));
    const a2 = await anchorHead(store, memSink(), { now: NOW + 1 });
    expect(await verifyChain(store, { anchors: [JSON.stringify(a1), a2!] })).toEqual({ ok: true, checked: 4 });
  });

  test("a forged anchor (bad signature) fails", async () => {
    const { store } = await filledDb(3, K1);
    const a = (await anchorHead(store, memSink(), { now: NOW }))!;
    const forged: Anchor = { ...a, seq: 2, hash: (await store.scan(1, 1))[0].hash };
    expect(await verifyChain(store, { anchors: [forged] })).toMatchObject({ ok: false, reason: expect.stringMatching(/signature/) });
    expect(await verifyChain(store, { anchors: [{ ...a, at: a.at + 1 }] })).toMatchObject({ ok: false, reason: expect.stringMatching(/signature/) });
  });

  test("with keys, unsigned anchors are refused (they could come from anyone with sink access)", async () => {
    const { store } = await filledDb(3, K1);
    const a = (await anchorHead(store, memSink(), { now: NOW }))!;
    expect(await verifyChain(store, { anchors: [{ ...a, signature: null, keyId: null }] })).toMatchObject({ ok: false, reason: expect.stringMatching(/unsigned/) });
  });

  test("an anchor signed with an unknown key fails", async () => {
    const { store } = await filledDb(2, K1);
    const a = (await anchorHead(store, memSink(), { now: NOW, key: K2 }))!;
    expect(await verifyChain(store, { keys: K1, anchors: [a] })).toMatchObject({ ok: false, reason: expect.stringMatching(/key/) });
    expect(await verifyChain(store, { keys: [K1, K2], anchors: [a] })).toEqual({ ok: true, checked: 2 });
  });

  test("malformed anchors are rejected", async () => {
    const { store } = await filledDb(1);
    expect(await codeOf(verifyChain(store, { anchors: ["not json"] }))).toBe("MIU_E_AUDIT_ANCHOR_INVALID");
    expect(await codeOf(verifyChain(store, { anchors: [{ seq: "1" } as any] }))).toBe("MIU_E_AUDIT_ANCHOR_INVALID");
    const a = (await anchorHead(store, memSink(), { now: NOW }))!;
    expect(await codeOf(verifyChain(store, { anchors: [{ ...a, keyId: "k_1" }] }))).toBe("MIU_E_AUDIT_ANCHOR_INVALID");
  });

  test("anchors before a purge are matched against the checkpoint", async () => {
    // Unkeyed so the anchors are unsigned and only the checkpoint comparison can catch the mismatch.
    const store = memoryAuditStore();
    for (let i = 1; i <= 4; i++) await store.append(entry(i, { ts: NOW - 100 * 86_400_000 }));
    const old = (await anchorHead(store, memSink(), { now: NOW }))!;
    await store.append(entry(5, { ts: NOW }));
    await purgeOlderThan(store, 30, { now: NOW });
    expect(await verifyChain(store, { anchors: [old] })).toMatchObject({ ok: true });
    // An anchor for a purged seq whose hash differs from the checkpoint is a mismatch.
    const s = { ...old, hash: "f".repeat(64) };
    expect(await verifyChain(store, { anchors: [s] })).toMatchObject({ ok: false, brokenAt: 4 });
  });
});

describe("sinks", () => {
  const dir = mkdtempSync(join(tmpdir(), "miu-audit-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("fileSink appends one JSON line per anchor and reads them back", async () => {
    const path = join(dir, "anchors.jsonl");
    const sink = fileSink(path);
    const store = memoryAuditStore({ key: K1 });
    await store.append(entry(1));
    const a1 = await anchorHead(store, sink, { now: NOW });
    await store.append(entry(2));
    const a2 = await anchorHead(store, sink, { now: NOW + 1 });
    expect(readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l))).toEqual([a1, a2]);
    const back = await sink.read();
    expect(back).toEqual([a1!, a2!]);
    expect(await verifyChain(store, { anchors: back })).toEqual({ ok: true, checked: 2 });
  });

  test("fileSink.read on a missing file is empty", async () => {
    expect(await fileSink(join(dir, "nope.jsonl")).read()).toEqual([]);
  });

  test("httpSink POSTs the anchor JSON with its key and headers", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return new Response(null, { status: 201 });
    };
    const store = memoryAuditStore({ key: K1 });
    await store.append(entry(1));
    const a = await anchorHead(store, httpSink("https://anchors.example/audit", { fetch: fetchFn, headers: { authorization: "Bearer t" } }), { now: NOW });
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("https://anchors.example/audit");
    expect(calls[0].init.method).toBe("POST");
    const h = new Headers(calls[0].init.headers);
    expect(h.get("content-type")).toContain("application/json");
    expect(h.get("authorization")).toBe("Bearer t");
    expect(h.get("x-audit-anchor-key")).toBe("audit-anchors/000000000000001.json");
    expect(JSON.parse(String(calls[0].init.body))).toEqual(a);
  });

  test("httpSink fails loudly on a non-2xx response", async () => {
    const store = memoryAuditStore();
    await store.append(entry(1));
    const sink = httpSink("https://anchors.example/audit", { fetch: async () => new Response("nope", { status: 500 }) });
    expect(await codeOf(anchorHead(store, sink))).toBe("MIU_E_AUDIT_ANCHOR_FAILED");
  });

  test("httpSink requires an http(s) URL", () => {
    expect(() => httpSink("ftp://x")).toThrow();
  });
});

describe("anchorJob", () => {
  test("is a plain async function using the env's key and binding (cron / queue)", async () => {
    const store = memoryAuditStore();
    const env = { AUDIT_HMAC_KEY: K1, ANCHORS: memSink() };
    await store.append(entry(1), env);
    const job = anchorJob({ store, sink: "ANCHORS", now: () => NOW });
    const a = await job(env);
    expect(a).toMatchObject({ seq: 1, at: NOW });
    expect(a!.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(env.ANCHORS.puts.length).toBe(1);
    expect(await verifyChain(store, { env, anchors: [a!] })).toEqual({ ok: true, checked: 1 });
  });

  test("works as a Workers scheduled handler (controller, env, ctx)", async () => {
    const store = memoryAuditStore({ key: K1 });
    await store.append(entry(1));
    const sink = memSink();
    const job = anchorJob({ store, sink });
    await job.scheduled({}, {}, {});
    expect(sink.puts.length).toBe(1);
  });
});
