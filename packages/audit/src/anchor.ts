// External anchoring: copy the chain head to a place the database's writers cannot reach, so
// truncation and wholesale rewrites show up in verifyChain({ anchors }).

import { detectRuntime, errors, type Env } from "miujs";
import { canonicalJson } from "./diff.ts";
import { envKeys, hmacHex, resolveKeys, type AuditKeys, type ResolvedKey } from "./keys.ts";
import { storeKeys, type AuditStore } from "./store.ts";

/** A signed copy of the chain head at a point in time. */
export interface Anchor {
  seq: number;
  hash: string;
  /** Epoch ms when the anchor was taken. */
  at: number;
  /** Key that signed it; null when unsigned (no key configured). */
  keyId: string | null;
  /** HMAC-SHA256 hex over seq, hash and at; null when unsigned. */
  signature: string | null;
}

/** Anything with `put(key, value)`: an R2 bucket, a KV namespace, or your own. */
export interface AnchorSink {
  put(key: string, value: string): Promise<unknown> | unknown;
}

export interface AnchorOptions {
  env?: Env;
  /** Signing key(s). Default: the store's key, then `env.AUDIT_HMAC_KEY`. Unsigned without one. */
  key?: AuditKeys;
  /** Default `Date.now()`. */
  now?: number;
  /** Sink key prefix. Default `"audit-anchors/"`. */
  prefix?: string;
}

/** The signed message. Versioned and domain-separated from row hashes. */
export function anchorSignature(key: ResolvedKey, a: Pick<Anchor, "seq" | "hash" | "at">): Promise<string> {
  return hmacHex(key.key, `miujs-audit-anchor-v1\n${key.id}\n${canonicalJson({ seq: a.seq, hash: a.hash, at: a.at })}`);
}

function resolveSink(sink: AnchorSink | string, env: Env): AnchorSink {
  if (typeof sink !== "string") return sink;
  const b = env[sink] as AnchorSink | undefined;
  if (!b || typeof b.put !== "function") {
    throw errors.config(
      "MIU_E_AUDIT_SINK_MISSING",
      `Anchor sink binding "${sink}" is not configured`,
      `Add an R2 bucket or KV namespace binding named ${sink} (in a different account or with write-only credentials if you can), or pass a sink object such as fileSink(path) or httpSink(url).`,
    );
  }
  return b;
}

/**
 * Writes the current head `{ seq, hash, at, keyId, signature }` to `sink` under
 * `<prefix><seq padded to 15 digits>.json`. Run it periodically (see `anchorJob`); keep the sink
 * outside the database's trust boundary. Returns null for an empty log.
 */
export async function anchorHead(store: AuditStore, sink: AnchorSink | string, opts: AnchorOptions = {}): Promise<Anchor | null> {
  const env = opts.env ?? {};
  const target = resolveSink(sink, env);
  const head = await store.head(env);
  if (!head) return null;
  const keys = opts.key ?? storeKeys(store) ?? envKeys(env);
  const signer = keys ? (await resolveKeys(keys))[0] : undefined;
  const base = { seq: head.seq, hash: head.hash, at: opts.now ?? Date.now() };
  const anchor: Anchor = { ...base, keyId: signer?.id ?? null, signature: signer ? await anchorSignature(signer, base) : null };
  const key = `${opts.prefix ?? "audit-anchors/"}${String(head.seq).padStart(15, "0")}.json`;
  await target.put(key, JSON.stringify(anchor));
  return anchor;
}

export interface AnchorJobOptions {
  store: AuditStore;
  sink: AnchorSink | string;
  key?: AuditKeys;
  prefix?: string;
  /** Clock, for tests. */
  now?: () => number;
}

export interface AnchorJob {
  /** Anchors the head now. Schedule it from a cron, a queue consumer or `setInterval`. */
  (env?: Env): Promise<Anchor | null>;
  /** The same job as a Workers handler: `app.on("scheduled", job.scheduled)`. */
  scheduled(controller: unknown, env: unknown, ctx?: unknown): Promise<void>;
}

/**
 * A plain async function that anchors the head:
 *
 * ```ts
 * const job = anchorJob({ store, sink: "AUDIT_ANCHORS" });
 * app.on("scheduled", job.scheduled);             // Workers cron
 * setInterval(() => job(process.env), 3_600_000); // Bun/Node
 * ```
 */
export function anchorJob(opts: AnchorJobOptions): AnchorJob {
  const run = (env: Env = {}) => anchorHead(opts.store, opts.sink, { env, key: opts.key, prefix: opts.prefix, now: opts.now?.() });
  const job = run as AnchorJob;
  job.scheduled = async (_controller, env) => {
    await run((env ?? {}) as Env);
  };
  return job;
}

/** File sink for Bun/Node: appends one JSON line per anchor. Put the file on separate, append-only storage. */
export function fileSink(path: string): AnchorSink & { read(): Promise<Anchor[]> } {
  const fs = async () => {
    if (detectRuntime() === "workerd") {
      throw errors.config("MIU_E_AUDIT_SINK_UNSUPPORTED", "fileSink() needs a filesystem", 'On Workers use an R2 bucket or KV binding: anchorHead(store, "AUDIT_ANCHORS").');
    }
    return import("node:fs/promises");
  };
  return {
    async put(_key, value) {
      await (await fs()).appendFile(path, `${value.replace(/\n/g, " ")}\n`, "utf8");
    },
    async read() {
      let text: string;
      try {
        text = await (await fs()).readFile(path, "utf8");
      } catch (err) {
        if ((err as { code?: string })?.code === "ENOENT") return [];
        throw err;
      }
      return text
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Anchor);
    },
  };
}

export interface HttpSinkOptions {
  /** Injectable fetch, e.g. for tests or a service binding. Default global `fetch`. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  headers?: HeadersInit;
}

/** POSTs each anchor as JSON to `url` (header `x-audit-anchor-key` carries the key). Non-2xx throws. */
export function httpSink(url: string, opts: HttpSinkOptions = {}): AnchorSink {
  if (!/^https?:\/\//i.test(url)) {
    throw errors.config("MIU_E_AUDIT_SINK_INVALID", `httpSink needs an http(s) URL, got ${JSON.stringify(url)}`, 'Pass the full endpoint, e.g. httpSink("https://anchors.example.com/audit").');
  }
  const doFetch = opts.fetch ?? ((u: string, init: RequestInit) => fetch(u, init));
  return {
    async put(key, value) {
      const headers = new Headers(opts.headers);
      headers.set("content-type", "application/json");
      headers.set("x-audit-anchor-key", key);
      const res = await doFetch(url, { method: "POST", headers, body: value });
      if (!res.ok) {
        throw errors.custom({
          code: "MIU_E_AUDIT_ANCHOR_FAILED",
          status: 502,
          message: `Anchor sink ${new URL(url).host} answered ${res.status}`,
          fix: "Check the sink URL and credentials; the anchor was not saved, so retry on the next run.",
        });
      }
    },
  };
}

const invalidAnchor = (why: string) =>
  errors.config("MIU_E_AUDIT_ANCHOR_INVALID", `Invalid audit anchor: ${why}`, "Pass anchors exactly as anchorHead wrote them: objects { seq, hash, at, keyId, signature } or their JSON strings.");

/** Parses and shape-checks an anchor. */
export function parseAnchor(a: Anchor | string): Anchor {
  let v: unknown = a;
  if (typeof a === "string") {
    try {
      v = JSON.parse(a);
    } catch {
      throw invalidAnchor("not JSON");
    }
  }
  const o = v as Partial<Anchor> | null;
  if (!o || typeof o !== "object") throw invalidAnchor("not an object");
  if (typeof o.seq !== "number" || !Number.isInteger(o.seq) || o.seq < 1) throw invalidAnchor("seq must be a positive integer");
  if (typeof o.hash !== "string" || !/^[0-9a-f]{64}$/.test(o.hash)) throw invalidAnchor("hash must be 64 hex characters");
  if (typeof o.at !== "number" || !Number.isFinite(o.at)) throw invalidAnchor("at must be epoch milliseconds");
  const keyId = o.keyId ?? null;
  const signature = o.signature ?? null;
  if (keyId !== null && typeof keyId !== "string") throw invalidAnchor("keyId must be a string or null");
  if (signature !== null && typeof signature !== "string") throw invalidAnchor("signature must be a string or null");
  if ((keyId === null) !== (signature === null)) throw invalidAnchor("keyId and signature go together");
  return { seq: o.seq, hash: o.hash, at: o.at, keyId, signature };
}
