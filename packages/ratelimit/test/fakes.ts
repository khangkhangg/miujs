// In-test fakes of platform bindings. They model the platform, not our code.

import { RateLimiterDurableObject } from "../src/index.ts";

/** Workers KV: string values, expirationTtl (min 60 s), get returns string | null. */
export function fakeKv(clock: () => number) {
  const data = new Map<string, { value: string; exp: number }>();
  return {
    data,
    puts: 0,
    async get(key: string): Promise<string | null> {
      const e = data.get(key);
      if (!e || e.exp <= clock()) return null;
      return e.value;
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number }) {
      if (opts?.expirationTtl !== undefined && opts.expirationTtl < 60) throw new Error("KV expirationTtl must be at least 60");
      this.puts++;
      data.set(key, { value, exp: opts?.expirationTtl ? clock() + opts.expirationTtl * 1000 : Infinity });
    },
    async delete(key: string) {
      data.delete(key);
    },
  };
}

/** Durable Object storage with async get/put and alarms. */
export function fakeStorage() {
  const map = new Map<string, unknown>();
  let alarm: number | null = null;
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return {
    map,
    get alarmAt() {
      return alarm;
    },
    async get(key: string) {
      await tick();
      return structuredClone(map.get(key));
    },
    async put(key: string, value: unknown) {
      await tick();
      map.set(key, structuredClone(value));
    },
    async delete(key: string) {
      return map.delete(key);
    },
    async deleteAll() {
      map.clear();
    },
    async setAlarm(t: number) {
      alarm = t;
    },
    async getAlarm() {
      return alarm;
    },
  };
}

/** A DurableObjectNamespace that runs the real RateLimiterDurableObject class. */
export function fakeDoNamespace() {
  const objects = new Map<string, { obj: RateLimiterDurableObject; storage: ReturnType<typeof fakeStorage> }>();
  return {
    objects,
    idFromName(name: string) {
      return { name, toString: () => `id:${name}` };
    },
    get(id: { name: string }) {
      let o = objects.get(id.name);
      if (!o) {
        const storage = fakeStorage();
        o = { obj: new RateLimiterDurableObject({ storage } as any, {}), storage };
        objects.set(id.name, o);
      }
      const { obj } = o;
      return { fetch: (input: RequestInfo | URL, init?: RequestInit) => obj.fetch(new Request(input, init)) };
    },
  };
}

/** Redis with INCR/INCRBY/PEXPIRE/GET/DEL semantics and a fake clock. */
export function fakeRedis(clock: () => number) {
  const data = new Map<string, { v: number; exp: number }>();
  const live = (k: string) => {
    const e = data.get(k);
    if (e && e.exp <= clock()) {
      data.delete(k);
      return undefined;
    }
    return e;
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return {
    data,
    async incrby(key: string, n: number) {
      await tick();
      const e = live(key) ?? { v: 0, exp: Infinity };
      e.v += n;
      data.set(key, e);
      return e.v;
    },
    async incr(key: string) {
      return this.incrby(key, 1);
    },
    async pexpire(key: string, ms: number) {
      const e = live(key);
      if (!e) return 0;
      e.exp = clock() + ms;
      return 1;
    },
    async get(key: string) {
      await tick();
      const e = live(key);
      return e ? String(e.v) : null;
    },
    async del(...keys: string[]) {
      for (const k of keys.flat()) data.delete(k);
      return keys.length;
    },
  };
}
