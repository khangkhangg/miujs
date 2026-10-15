import type { RoomStorage } from "./define.ts";

/** In-memory room storage (local runtimes and tests). Values are cloned on the way in and out. */
export class MemoryStorage implements RoomStorage {
  private map = new Map<string, unknown>();

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const v = this.map.get(key);
    return v === undefined ? undefined : (structuredClone(v) as T);
  }
  async put(key: string, value: unknown): Promise<void> {
    this.map.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<boolean> {
    return this.map.delete(key);
  }
}
