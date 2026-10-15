// Join codes: short 6-digit codes that resolve to a room (`{ type, id }`). In memory locally;
// a KV namespace on Cloudflare (so every isolate sees the same codes). Codes expire.

import { errors } from "miujs";
import type { Clock } from "./clock.ts";

export interface CodeTarget {
  type: string;
  id: string;
}

export interface CodeStore {
  get(code: string): Promise<CodeTarget | null>;
  /** Store `code → target` unless the code is live. False when it is taken. */
  claim(code: string, target: CodeTarget, ttlMs: number): Promise<boolean>;
}

export const CODE_RE = /^\d{6}$/;

/** A random 6-digit join code (100000-999999). */
export function createCode(): string {
  const b = new Uint32Array(1);
  crypto.getRandomValues(b);
  return String(100_000 + (b[0] % 900_000));
}

export class MemoryCodeStore implements CodeStore {
  private map = new Map<string, { target: CodeTarget; expires: number }>();
  private clock: Clock;

  constructor(clock: Clock) {
    this.clock = clock;
  }

  async get(code: string): Promise<CodeTarget | null> {
    const e = this.map.get(code);
    if (!e) return null;
    if (e.expires <= this.clock.now()) {
      this.map.delete(code);
      return null;
    }
    return { ...e.target };
  }

  async claim(code: string, target: CodeTarget, ttlMs: number): Promise<boolean> {
    if (await this.get(code)) return false;
    this.map.set(code, { target: { ...target }, expires: this.clock.now() + ttlMs });
    return true;
  }
}

/** The parts of a Workers KV namespace we use. */
export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

/**
 * Codes in Workers KV. KV has no compare-and-set, so two isolates claiming the same random code
 * in the same instant could both win; with 900 000 codes that is vanishingly rare.
 */
export class KvCodeStore implements CodeStore {
  private kv: KvLike;
  private prefix: string;

  constructor(kv: KvLike, prefix = "miu:code:") {
    this.kv = kv;
    this.prefix = prefix;
  }

  async get(code: string): Promise<CodeTarget | null> {
    const raw = await this.kv.get(this.prefix + code);
    if (!raw) return null;
    try {
      const v = JSON.parse(raw);
      return v && typeof v.type === "string" && typeof v.id === "string" ? { type: v.type, id: v.id } : null;
    } catch {
      return null;
    }
  }

  async claim(code: string, target: CodeTarget, ttlMs: number): Promise<boolean> {
    if (await this.get(code)) return false;
    // KV's minimum TTL is 60 seconds.
    await this.kv.put(this.prefix + code, JSON.stringify(target), { expirationTtl: Math.max(60, Math.ceil(ttlMs / 1000)) });
    return true;
  }
}

/** Claim a fresh code for `target`, retrying on collisions with live codes. */
export async function allocateCode(store: CodeStore, target: CodeTarget, ttlMs: number, gen: () => string = createCode, attempts = 20): Promise<string> {
  for (let i = 0; i < attempts; i++) {
    const code = gen();
    if (await store.claim(code, target, ttlMs)) return code;
  }
  throw errors.custom({
    code: "MIU_E_ROOM_CODES_EXHAUSTED",
    status: 503,
    message: `Could not find a free join code after ${attempts} tries`,
    fix: "Too many live codes: lower codeTtlMs in rooms({ ... }) so old codes expire sooner, or join rooms by id.",
  });
}
