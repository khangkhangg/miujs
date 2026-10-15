import { errors, t, type Context, type ManageAction, type ManageSection, type ManageStat } from "miujs";
import { cacheStats, createCache } from "./client.ts";
import type { CacheStore } from "./store.ts";

/** Most keys one purge run deletes; the operator runs it again for the rest. */
export const PURGE_BATCH = 1000;
const PAGE = 100;

const noList = (store: CacheStore) =>
  errors.badRequest(
    `The ${store.name} cache store cannot list keys, so it cannot be browsed or purged by prefix`,
    store.name === "kv" ? "Pass the KV namespace binding itself (it has list()), or delete keys one by one / by tag." : "Delete keys one by one or by tag, or use the memory store.",
  );

async function purge(store: CacheStore, prefix: string): Promise<{ deleted: number; more: boolean }> {
  if (!store.scan) throw noList(store);
  let deleted = 0;
  let cursor: string | undefined;
  do {
    const page = await store.scan({ prefix, cursor, limit: Math.min(PAGE, PURGE_BATCH - deleted) });
    await Promise.all(page.keys.map((k) => store.delete(k.key)));
    deleted += page.keys.length;
    cursor = page.next;
  } while (cursor && deleted < PURGE_BATCH);
  return { deleted, more: cursor !== undefined };
}

const plural = (n: number) => `${n} key${n === 1 ? "" : "s"}`;

/** The cache's admin section. `resolve` returns the store a request uses. */
export function cacheManage(resolve: (ctx: Context) => CacheStore): ManageSection[] {
  const deleteKey = (name: string, title: string, field: "key" | "id"): ManageAction<Record<string, string>> => ({
    name,
    title,
    description: "Delete one cache entry. Deleting a missing key is fine.",
    input: t.object({ [field]: t.string({ minLength: 1 }) }),
    async run(input, ctx) {
      await createCache(resolve(ctx)).delete(input[field]);
      return `Deleted ${JSON.stringify(input[field])}.`;
    },
  });

  return [
    {
      id: "cache",
      title: "Cache",
      description: "Key/value cache entries, hit rate and purging.",
      status(ctx) {
        const store = resolve(ctx);
        const { hits, misses } = cacheStats(store);
        const stats: ManageStat[] = [
          { label: "Store", value: store.name },
          store.size
            ? { label: "Entries", value: store.size() }
            : { label: "Entries", value: null, hint: `Entries are not countable on the ${store.name} store.` },
          store.bytes
            ? { label: "Size", value: store.bytes(), hint: "Total length of the stored JSON values." }
            : { label: "Size", value: null, hint: `Size is not known on the ${store.name} store.` },
          { label: "Hits", value: hits, hint: "Reads served from the cache by this instance since it started." },
          { label: "Misses", value: misses, hint: "Reads that found nothing, in this instance." },
          { label: "Hit rate", value: hits + misses ? `${Math.round((hits / (hits + misses)) * 100)}%` : "n/a" },
        ];
        return { stats };
      },
      lists: [
        {
          name: "keys",
          title: "Keys",
          columns: [
            { key: "key", label: "Key", type: "code" },
            { key: "bytes", label: "Size", type: "bytes" },
            { key: "expiresAt", label: "Expires", type: "date" },
          ],
          idKey: "key",
          searchable: true,
          async list(q, ctx) {
            const store = resolve(ctx);
            if (!store.scan) throw noList(store);
            const page = await store.scan({ prefix: q.search || undefined, cursor: q.cursor, limit: Math.max(1, Math.min(q.limit, PAGE)) });
            const rows = page.keys.map((k) => ({ key: k.key, bytes: k.bytes, expiresAt: k.expiresAt === null ? null : new Date(k.expiresAt).toISOString() }));
            return page.next ? { rows, next: page.next } : { rows };
          },
          rowActions: [deleteKey("delete", "Delete", "id")],
        },
      ],
      actions: [
        deleteKey("deleteKey", "Delete a key", "key"),
        {
          name: "invalidateTag",
          title: "Invalidate a tag",
          description: "Delete every key that was set with this tag.",
          input: t.object({ tag: t.string({ minLength: 1 }) }),
          async run(input: { tag: string }, ctx) {
            await createCache(resolve(ctx)).invalidateTag(input.tag);
            return `Invalidated tag ${JSON.stringify(input.tag)}.`;
          },
        },
        {
          name: "purgePrefix",
          title: "Purge by prefix",
          description: `Delete keys starting with a prefix (up to ${PURGE_BATCH} per run). Needs a store that can list keys.`,
          danger: true,
          input: t.object({ prefix: t.string({ minLength: 1 }) }),
          async run(input: { prefix: string }, ctx) {
            const { deleted, more } = await purge(resolve(ctx), input.prefix);
            return `Deleted ${plural(deleted)} starting with ${JSON.stringify(input.prefix)}.${more ? " More remain: run again." : ""}`;
          },
        },
        {
          name: "purgeAll",
          title: "Purge everything",
          description: `Delete every cache entry (up to ${PURGE_BATCH} per run on stores without a clear).`,
          danger: true,
          async run(_input, ctx) {
            const store = resolve(ctx);
            if (store.clear) return `Deleted ${plural(await store.clear())}.`;
            const { deleted, more } = await purge(store, "");
            return `Deleted ${plural(deleted)}.${more ? " More remain: run again." : ""}`;
          },
        },
      ],
    },
  ];
}
