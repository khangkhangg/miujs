import {
  ConflictError, assertField, clampLimit, newId,
  type CreateInput, type Doc, type ListQuery, type ListResult, type Repository,
} from "./types.ts";

export interface MemoryRepositoryOptions<T> {
  /** Fields searched by `q`. Default: every string field. */
  searchFields?: (keyof T & string)[];
}

/** In-process repository for development and tests (not shared across instances). */
export function memoryRepository<T extends Doc>(opts: MemoryRepositoryOptions<T> = {}): Repository<T> {
  const docs = new Map<string, T>();
  const copy = (d: T): T => structuredClone(d);
  // Runs synchronously with the write that follows it, so check-and-insert is atomic in-process.
  const assertUnique = (fields: string[] | undefined, next: Record<string, unknown>, selfId?: string) => {
    if (!fields?.length) return;
    const taken = fields.filter((f) => {
      assertField(f);
      const v = next[f];
      if (v === undefined) return false;
      for (const d of docs.values()) if (d.id !== selfId && (d as Record<string, unknown>)[f] === v) return true;
      return false;
    });
    if (taken.length) throw new ConflictError(taken);
  };

  return {
    async list(query: ListQuery = {}): Promise<ListResult<T>> {
      let items = [...docs.values()];
      if (query.where) {
        for (const [k, v] of Object.entries(query.where)) {
          assertField(k);
          items = items.filter((d) => (d as Record<string, unknown>)[k] === v);
        }
      }
      if (query.q) {
        const needle = query.q.toLowerCase();
        items = items.filter((d) => {
          const fields = opts.searchFields ?? Object.keys(d);
          return fields.some((f) => {
            const v = (d as Record<string, unknown>)[f];
            return typeof v === "string" && v.toLowerCase().includes(needle);
          });
        });
      }
      if (query.sort) {
        const desc = query.sort.startsWith("-");
        const field = assertField(desc ? query.sort.slice(1) : query.sort);
        items.sort((a, b) => compare((a as Record<string, unknown>)[field], (b as Record<string, unknown>)[field]) * (desc ? -1 : 1));
      }
      const offset = Math.max(0, query.offset ?? 0);
      return { total: items.length, items: items.slice(offset, offset + clampLimit(query.limit)).map(copy) };
    },
    async get(id) {
      const d = docs.get(id);
      return d && copy(d);
    },
    async create(data: CreateInput<T>, o = {}) {
      const id = data.id ?? newId();
      if (docs.has(id)) throw new Error(`Duplicate id: ${id}`);
      assertUnique(o.unique, data as Record<string, unknown>);
      const now = new Date().toISOString();
      const doc = { ...structuredClone(data), id, createdAt: now, updatedAt: now } as unknown as T;
      docs.set(id, doc);
      return copy(doc);
    },
    async update(id, patch, o = {}) {
      const cur = docs.get(id);
      if (!cur) return undefined;
      const { id: _i, createdAt: _c, ...rest } = structuredClone(patch) as Record<string, unknown>;
      assertUnique(o.unique, { ...(cur as Record<string, unknown>), ...rest }, id);
      const next = { ...cur, ...rest, id, createdAt: cur.createdAt, updatedAt: new Date().toISOString() } as T;
      docs.set(id, next);
      return copy(next);
    },
    async delete(id) {
      return docs.delete(id);
    },
  };
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === undefined || a === null) return 1;
  if (b === undefined || b === null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : 1;
}
