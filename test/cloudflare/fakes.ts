/** In-memory fakes of Cloudflare bindings, faithful enough to exercise the adapters. */
import { Database } from "bun:sqlite";
import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
  DurableObjectNamespace,
  DurableObjectState,
  DurableObjectStorage,
  KVNamespace,
  KVNamespacePutOptions,
  Message,
  MessageBatch,
  QueueProducer,
  QueueSendOptions,
  R2Bucket,
  R2GetOptions,
  R2Object,
  R2ObjectBody,
  R2PutOptions,
  R2Range,
} from "../../src/adapters/cloudflare/types.ts";

// ----- KV -----

export function fakeKV(now: () => number = Date.now) {
  const data = new Map<string, { value: string; metadata: unknown; exp: number | null }>();
  const puts: { key: string; options?: KVNamespacePutOptions }[] = [];
  const live = (key: string) => {
    const e = data.get(key);
    if (e && e.exp !== null && e.exp <= now()) {
      data.delete(key);
      return undefined;
    }
    return e;
  };
  const kv: KVNamespace & { data: typeof data; puts: typeof puts } = {
    data,
    puts,
    async get(key) {
      return live(key)?.value ?? null;
    },
    async getWithMetadata<M>(key: string) {
      const e = live(key);
      return { value: e?.value ?? null, metadata: (e?.metadata ?? null) as M | null };
    },
    async put(key, value, options) {
      puts.push({ key, options });
      if (options?.expirationTtl !== undefined && options.expirationTtl < 60) {
        throw new Error("KV PUT failed: 400 Invalid expiration_ttl of " + options.expirationTtl);
      }
      const exp =
        options?.expirationTtl !== undefined
          ? now() + options.expirationTtl * 1000
          : options?.expiration !== undefined
            ? options.expiration * 1000
            : null;
      data.set(key, { value, metadata: options?.metadata ?? null, exp });
    },
    async delete(key) {
      data.delete(key);
    },
  };
  return kv;
}

// ----- D1 over bun:sqlite -----

export function fakeD1(db = new Database(":memory:")): D1Database & { sqlite: Database } {
  const stmt = (sql: string, params: unknown[] = []): D1PreparedStatement => ({
    bind: (...values) => stmt(sql, values),
    async first<T>() {
      return (db.query(sql).get(...(params as never[])) as T) ?? null;
    },
    async run<T>() {
      const q = db.query(sql);
      if (/\breturning\b/i.test(sql)) {
        return { results: q.all(...(params as never[])) as T[], success: true, meta: {} };
      }
      const r = q.run(...(params as never[]));
      return { results: [] as T[], success: true, meta: { changes: r.changes } };
    },
    async all<T>() {
      return { results: db.query(sql).all(...(params as never[])) as T[], success: true, meta: {} };
    },
  });
  return {
    sqlite: db,
    prepare: (sql) => stmt(sql),
    async batch<T>(statements: D1PreparedStatement[]) {
      const out: D1Result<T>[] = [];
      db.exec("BEGIN");
      try {
        for (const s of statements) out.push((await s.run()) as D1Result<T>);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      return out;
    },
    async exec(sql) {
      db.exec(sql);
      return { count: 1, duration: 0 };
    },
  };
}

// ----- R2 -----

const toBytes = async (v: unknown): Promise<Uint8Array> => {
  if (v === null || v === undefined) return new Uint8Array();
  if (typeof v === "string") return new TextEncoder().encode(v);
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice();
  if (v instanceof Blob) return new Uint8Array(await v.arrayBuffer());
  if (v instanceof ReadableStream) return new Uint8Array(await new Response(v).arrayBuffer());
  throw new Error("unsupported body");
};

export function fakeR2(): R2Bucket & { objects: Map<string, { bytes: Uint8Array; meta: R2Object }> } {
  const objects = new Map<string, { bytes: Uint8Array; meta: R2Object }>();
  let n = 0;
  const makeMeta = (key: string, size: number, etag: string, o: R2PutOptions = {}, range?: R2Range): R2Object => ({
    key,
    size,
    etag,
    httpEtag: `"${etag}"`,
    uploaded: new Date(0),
    httpMetadata: o.httpMetadata ?? {},
    customMetadata: o.customMetadata ?? {},
    range,
    writeHttpMetadata(h: Headers) {
      if (o.httpMetadata?.contentType) h.set("content-type", o.httpMetadata.contentType);
      if (o.httpMetadata?.cacheControl) h.set("cache-control", o.httpMetadata.cacheControl);
    },
  });
  const withBody = (meta: R2Object, bytes: Uint8Array): R2ObjectBody => {
    const res = new Response(bytes as unknown as BodyInit);
    return Object.assign(Object.create(null), meta, {
      writeHttpMetadata: meta.writeHttpMetadata,
      body: res.body!,
      get bodyUsed() {
        return res.bodyUsed;
      },
      arrayBuffer: () => res.arrayBuffer(),
      text: () => res.text(),
      json: () => res.json(),
    });
  };
  return {
    objects,
    async head(key) {
      return objects.get(key)?.meta ?? null;
    },
    async get(key, options: R2GetOptions = {}) {
      const o = objects.get(key);
      if (!o) return null;
      if (options.onlyIf?.etagDoesNotMatch !== undefined && options.onlyIf.etagDoesNotMatch === o.meta.etag) {
        return o.meta;
      }
      if (options.range) {
        const r = options.range as { offset?: number; length?: number; suffix?: number };
        const size = o.bytes.length;
        let start: number;
        let end: number;
        if (r.suffix !== undefined) {
          start = Math.max(0, size - r.suffix);
          end = size;
        } else {
          start = r.offset ?? 0;
          end = r.length !== undefined ? Math.min(size, start + r.length) : size;
        }
        if (start >= size) throw new Error("get: The requested range is not satisfiable (10039)");
        const meta = { ...o.meta, range: { offset: start, length: end - start } };
        return withBody(meta, o.bytes.slice(start, end));
      }
      return withBody(o.meta, o.bytes);
    },
    async put(key, value, options) {
      const bytes = await toBytes(value);
      const meta = makeMeta(key, bytes.length, `etag${++n}`, options);
      objects.set(key, { bytes, meta });
      return meta;
    },
    async delete(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
    },
    async list(options = {}) {
      const all = [...objects.keys()].filter((k) => k.startsWith(options.prefix ?? "")).sort();
      const start = options.cursor ? Number(options.cursor) : 0;
      const limit = options.limit ?? 1000;
      const page = all.slice(start, start + limit);
      const truncated = start + limit < all.length;
      return {
        objects: page.map((k) => objects.get(k)!.meta),
        truncated,
        cursor: truncated ? String(start + limit) : undefined,
        delimitedPrefixes: [],
      };
    },
  };
}

// ----- Queues -----

export function fakeQueueProducer<B = unknown>() {
  const sent: { body: B; options?: QueueSendOptions }[] = [];
  const producer: QueueProducer<B> & { sent: typeof sent } = {
    sent,
    async send(body, options) {
      sent.push({ body: structuredClone(body), options });
    },
  };
  return producer;
}

export type FakeMessage<B> = Message<B> & { acked: boolean; retried: { delaySeconds?: number } | null };

export function fakeMessage<B>(body: B, attempts = 1, id = crypto.randomUUID()): FakeMessage<B> {
  const m: FakeMessage<B> = {
    id,
    timestamp: new Date(0),
    body,
    attempts,
    acked: false,
    retried: null,
    ack() {
      m.acked = true;
    },
    retry(o = {}) {
      m.retried = o;
    },
  };
  return m;
}

export function fakeBatch<B>(messages: FakeMessage<B>[], queue = "jobs"): MessageBatch<B> {
  return {
    queue,
    messages,
    ackAll: () => messages.forEach((m) => m.ack()),
    retryAll: (o) => messages.forEach((m) => m.retry(o)),
  };
}

// ----- Durable Objects -----

type FakeState = DurableObjectState & { alarm: number | null; data: Map<string, unknown> };

export function fakeDurableObjectState(): FakeState {
  const data = new Map<string, unknown>();
  const state: FakeState = {
    data,
    alarm: null as number | null,
    storage: {
      async get<T>(key: string) {
        await Promise.resolve();
        return structuredClone(data.get(key)) as T | undefined;
      },
      async put(key: string, value: unknown) {
        await Promise.resolve();
        data.set(key, structuredClone(value));
      },
      async delete(key: string) {
        await Promise.resolve();
        return data.delete(key);
      },
      async list<T>(o: { prefix?: string; limit?: number } = {}) {
        const keys = [...data.keys()].filter((k) => k.startsWith(o.prefix ?? "")).sort().slice(0, o.limit);
        return new Map(keys.map((k) => [k, structuredClone(data.get(k)) as T]));
      },
      async getAlarm() {
        return state.alarm;
      },
      async setAlarm(t: number | Date) {
        state.alarm = typeof t === "number" ? t : t.getTime();
      },
    } satisfies DurableObjectStorage,
    blockConcurrencyWhile: <T>(fn: () => Promise<T>) => fn(),
  };
  return state;
}

/** A namespace that routes each name to one object instance built by `create`. */
export function fakeDurableObjectNamespace(create: (state: DurableObjectState) => { fetch(req: Request): Promise<Response> }) {
  const instances = new Map<string, { fetch(req: Request): Promise<Response> }>();
  const ns: DurableObjectNamespace & { instances: typeof instances } = {
    instances,
    idFromName: (name) => ({ toString: () => name }),
    get(id) {
      const name = id.toString();
      return {
        fetch: (input, init) => {
          let obj = instances.get(name);
          if (!obj) instances.set(name, (obj = create(fakeDurableObjectState())));
          return obj.fetch(new Request(input, init));
        },
      };
    },
  };
  return ns;
}
