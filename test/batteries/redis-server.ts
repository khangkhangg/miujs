/**
 * Test helper: a real Redis for the Redis driver suites.
 * Uses REDIS_URL when set; otherwise starts a throwaway `redis-server` (no persistence) on a free port.
 * Resolves to undefined (and the suites skip with a message) when neither is available.
 */
import { afterAll } from "bun:test";
import { RedisClient } from "bun";

export interface TestRedis {
  url: string;
  client: RedisClient;
  /** Shut the throwaway server down (no-op for REDIS_URL). */
  stop(): Promise<void>;
  /** A fresh key prefix so tests never see each other's data. */
  prefix(): string;
}

async function ping(url: string): Promise<RedisClient | undefined> {
  const client = new RedisClient(url, { connectionTimeout: 500, autoReconnect: false, maxRetries: 0 });
  try {
    await client.connect();
    await client.send("PING", []);
    return client;
  } catch {
    client.close();
    return undefined;
  }
}

async function start(): Promise<TestRedis | undefined> {
  let url = process.env.REDIS_URL;
  let owned: ReturnType<typeof Bun.spawn> | undefined;
  if (!url) {
    const bin = Bun.which("redis-server");
    if (!bin) return undefined;
    for (let attempt = 0; attempt < 5 && !url; attempt++) {
      const port = 20_000 + Math.floor(Math.random() * 30_000);
      const proc = Bun.spawn([bin, "--port", String(port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      for (let i = 0; i < 50; i++) {
        if (proc.exitCode !== null) break;
        const c = await ping(`redis://127.0.0.1:${port}`);
        if (c) {
          c.close();
          url = `redis://127.0.0.1:${port}`;
          owned = proc;
          break;
        }
        await Bun.sleep(20);
      }
      if (!url) proc.kill();
    }
    if (!url) return undefined;
  }
  const client = await ping(url);
  if (!client) return undefined;
  const stop = async () => {
    client.close();
    if (owned) {
      owned.kill();
      await owned.exited;
    }
  };
  return { url, client, stop, prefix: () => `miu-test:${crypto.randomUUID()}:` };
}

/** Start (or connect to) Redis for one test file; stops it in that file's afterAll. */
export async function testRedis(): Promise<TestRedis | undefined> {
  const r = await start();
  if (!r) console.warn("[redis] skipping Redis driver tests: set REDIS_URL or install redis-server");
  else afterAll(() => r.stop());
  return r;
}
