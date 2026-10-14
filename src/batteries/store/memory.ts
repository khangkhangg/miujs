import { prefixed, remainingSeconds, type Store } from "./types.ts";

export interface MemoryStoreOptions {
  /** Clock in milliseconds; injectable for tests. */
  now?: () => number;
}

/** In-process store. Per-instance only: not shared across workers or isolates. */
export function memoryStore(opts: MemoryStoreOptions = {}): Store {
  const now = opts.now ?? Date.now;
  // Values are stored serialized so callers can't mutate stored objects by reference.
  const data = new Map<string, { v: string; exp: number | null }>();
  let writes = 0;

  const live = (key: string) => {
    const e = data.get(key);
    if (!e) return undefined;
    if (e.exp !== null && e.exp <= now()) {
      data.delete(key);
      return undefined;
    }
    return e;
  };

  const sweep = () => {
    if (++writes % 1000 !== 0) return;
    const t = now();
    for (const [k, e] of data) if (e.exp !== null && e.exp <= t) data.delete(k);
  };

  const store: Store = {
    async get<T>(key: string) {
      const e = live(key);
      return e ? (JSON.parse(e.v) as T) : undefined;
    },
    async set(key, value, o) {
      data.set(key, { v: JSON.stringify(value), exp: o?.ttl ? now() + o.ttl * 1000 : null });
      sweep();
    },
    async delete(key) {
      const existed = live(key) !== undefined;
      data.delete(key);
      return existed;
    },
    async has(key) {
      return live(key) !== undefined;
    },
    async incr(key, by = 1, o) {
      const e = live(key);
      if (!e) {
        data.set(key, { v: String(by), exp: o?.ttl ? now() + o.ttl * 1000 : null });
        sweep();
        return by;
      }
      const n = Number(JSON.parse(e.v)) + by;
      e.v = String(n);
      return n;
    },
    async ttl(key) {
      const e = live(key);
      return e ? remainingSeconds(e.exp, now()) : undefined;
    },
    prefix: (p) => prefixed(store, p),
    async close() {
      data.clear();
    },
  };
  return store;
}
