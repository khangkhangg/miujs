import { prefixed, remainingSeconds, type Store } from "../../batteries/store/types.ts";
import { resolveBinding, type BindingRef, type DurableObjectNamespace, type DurableObjectState } from "./types.ts";

interface Entry {
  v: unknown;
  /** Absolute expiry in ms, or null. */
  e: number | null;
}

type Op = "get" | "set" | "delete" | "has" | "incr" | "ttl";
const OPS = new Set<string>(["get", "set", "delete", "has", "incr", "ttl"]);

/**
 * A Durable Object that serves a strongly consistent {@link Store} over its storage.
 * Operations run one at a time, so `incr` is atomic: the right backend for rate limits.
 *
 * Export it from your worker and bind it in wrangler.toml:
 * ```ts
 * export { MiuStoreObject } from "miujs/cloudflare";
 * ```
 * Expired keys are hidden on read and deleted by an alarm scheduled for the earliest
 * expiry, so storage does not grow with dead keys. The RPC is `POST` with JSON
 * `{ op, args }` answered by `{ r }` (or `{ error }` with status 400/500).
 */
export class MiuStoreObject {
  protected readonly state: DurableObjectState;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(state: DurableObjectState, _env?: unknown) {
    this.state = state;
  }

  /** Clock in milliseconds; override in tests. */
  protected now(): number {
    return Date.now();
  }

  async fetch(req: Request): Promise<Response> {
    if (req.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
    let op: unknown;
    let args: unknown;
    try {
      ({ op, args } = (await req.json()) as { op: unknown; args: unknown });
    } catch {
      return Response.json({ error: "Malformed JSON" }, { status: 400 });
    }
    if (typeof op !== "string" || !OPS.has(op) || !Array.isArray(args) || typeof args[0] !== "string") {
      return Response.json({ error: `Unknown op: ${String(op)}` }, { status: 400 });
    }
    try {
      const r = await this.#serial(() => this.#run(op as Op, args as [string, ...unknown[]]));
      return Response.json({ r });
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  }

  /** Delete expired keys and reschedule for the next expiry. */
  async alarm(): Promise<void> {
    await this.#serial(async () => {
      const t = this.now();
      let next: number | null = null;
      for (const [k, entry] of await this.state.storage.list<Entry>()) {
        if (entry.e === null) continue;
        if (entry.e <= t) await this.state.storage.delete(k);
        else if (next === null || entry.e < next) next = entry.e;
      }
      if (next !== null) await this.state.storage.setAlarm?.(next);
    });
  }

  // Storage awaits could interleave otherwise; a promise chain keeps each op atomic.
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => {});
    return run;
  }

  async #live(key: string): Promise<Entry | undefined> {
    const entry = await this.state.storage.get<Entry>(key);
    if (!entry) return undefined;
    if (entry.e !== null && entry.e <= this.now()) {
      await this.state.storage.delete(key);
      return undefined;
    }
    return entry;
  }

  async #put(key: string, entry: Entry): Promise<void> {
    await this.state.storage.put(key, entry);
    const { getAlarm, setAlarm } = this.state.storage;
    if (entry.e === null || !getAlarm || !setAlarm) return;
    const current = await this.state.storage.getAlarm!();
    if (current === null || entry.e < current) await this.state.storage.setAlarm!(entry.e);
  }

  async #run(op: Op, [key, ...rest]: [string, ...unknown[]]): Promise<unknown> {
    const expiry = (ttl: unknown) => (typeof ttl === "number" && ttl > 0 ? this.now() + ttl * 1000 : null);
    switch (op) {
      case "get":
        return (await this.#live(key))?.v;
      case "has":
        return (await this.#live(key)) !== undefined;
      case "ttl": {
        const entry = await this.#live(key);
        return entry ? remainingSeconds(entry.e, this.now()) : undefined;
      }
      case "set": {
        const o = rest[1] as { ttl?: number } | undefined;
        await this.#put(key, { v: rest[0], e: expiry(o?.ttl) });
        return undefined;
      }
      case "delete": {
        const existed = (await this.#live(key)) !== undefined;
        if (existed) await this.state.storage.delete(key);
        return existed;
      }
      case "incr": {
        const by = typeof rest[0] === "number" ? rest[0] : 1;
        const o = rest[1] as { ttl?: number } | undefined;
        const entry = await this.#live(key);
        const next: Entry = entry ? { v: Number(entry.v) + by, e: entry.e } : { v: by, e: expiry(o?.ttl) };
        await this.#put(key, next);
        return next.v;
      }
    }
  }
}

export interface DoStoreOptions {
  /** Object name, or a function of the key to shard keys across objects. Default "miu-store". */
  name?: string | ((key: string) => string);
}

/**
 * Client {@link Store} backed by {@link MiuStoreObject}. Strongly consistent with an
 * atomic `incr`. A single name means a single object (roughly 1k req/s); pass a
 * function to shard hot workloads, e.g. `name: (k) => "rl-" + (hash(k) % 16)`.
 *
 * `namespace` may be a getter such as `() => env.MIU_STORE`.
 */
export function doStore(namespace: BindingRef<DurableObjectNamespace>, opts: DoStoreOptions = {}): Store {
  const name = opts.name ?? "miu-store";
  const call = async <T>(op: Op, args: [string, ...unknown[]]): Promise<T> => {
    const ns = resolveBinding(namespace);
    const id = ns.idFromName(typeof name === "function" ? name(args[0]) : name);
    const res = await ns.get(id).fetch("https://miu-store/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op, args }),
    });
    const out = (await res.json()) as { r?: T; error?: string };
    if (!res.ok) throw new Error(`MiuStoreObject ${op} failed: ${out.error ?? res.status}`);
    return out.r as T;
  };

  const store: Store = {
    get: <T>(key: string) => call<T | undefined>("get", [key]),
    set: (key, value, o) => call<void>("set", [key, value, o]),
    delete: (key) => call<boolean>("delete", [key]),
    has: (key) => call<boolean>("has", [key]),
    incr: (key, by = 1, o) => call<number>("incr", [key, by, o]),
    ttl: (key) => call<number | undefined>("ttl", [key]),
    prefix: (p) => prefixed(store, p),
    async close() {},
  };
  return store;
}
