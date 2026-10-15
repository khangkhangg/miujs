/** Minimal fake of Cloudflare's KVNamespace (get/put/delete with expirationTtl). */
export function fakeKV(now: () => number = Date.now) {
  const data = new Map<string, { value: string; exp: number }>();
  const puts: { key: string; value: string; options?: { expirationTtl?: number } }[] = [];
  return {
    data,
    puts,
    async get(key: string): Promise<string | null> {
      const e = data.get(key);
      if (!e || e.exp <= now()) return null;
      return e.value;
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
      if (options?.expirationTtl !== undefined && options.expirationTtl < 60) throw new Error("KV PUT failed: 400 Invalid expiration_ttl of " + options.expirationTtl);
      puts.push({ key, value, options });
      data.set(key, { value, exp: options?.expirationTtl ? now() + options.expirationTtl * 1000 : Infinity });
    },
    async delete(key: string): Promise<void> {
      data.delete(key);
    },
  };
}
