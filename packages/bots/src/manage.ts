// The bots plugin's admin section: traffic and cache counters, recently blocked visitors, live
// policy/country/cache settings, cache purging and a User-Agent tester.

import { errors, t, type Context, type ManageSection, type ManageStat, type ManageValue } from "miujs";
import type { Classifier } from "./agents.ts";
import type { Access, VisitorKind } from "./detect.ts";
import type { BotCacheStore } from "./store.ts";

/** Blocked visits remembered for the admin list (per instance; the oldest are dropped). */
export const BLOCKED_LOG = 200;
const PAGE = 100;

const KINDS = ["human", "search", "ai", "bot", "unknown"] as const satisfies readonly VisitorKind[];
const ACTIONS = ["full", "partial", "cached", "block"] as const satisfies readonly Access[];
const COUNTRY = /^(?:[A-Za-z]{2}|T1|t1)$/;

export interface BlockedVisit {
  /** Epoch ms. */
  at: number;
  kind: VisitorKind;
  name: string | null;
  country: string | null;
  /** Path only: query strings can carry tokens. */
  path: string;
  /** What decided the block: "policy", "route policy", "rule <n>", "country blocked", "country not allowed". */
  reason: string;
}

/** A fixed-size ring buffer: `push` overwrites the oldest entry once full. */
export interface Ring<T> {
  push(item: T): void;
  /** Newest first. */
  newest(): T[];
  readonly size: number;
}

export function ring<T>(capacity: number): Ring<T> {
  const items: T[] = [];
  let next = 0;
  return {
    push(item) {
      if (items.length < capacity) items.push(item);
      else items[next] = item;
      next = (next + 1) % capacity;
    },
    newest() {
      const out: T[] = [];
      for (let i = 1; i <= items.length; i++) out.push(items[(next - i + capacity) % capacity]);
      return out;
    },
    get size() {
      return items.length;
    },
  };
}

interface Live {
  blockCountries: string[];
  allowCountries: string[];
  botScoreThreshold: number;
  ttl: number;
}

/** @internal What the plugin shares with its admin section. */
export interface BotsManageState {
  policy: Record<VisitorKind, Access>;
  counters: {
    kinds: Record<VisitorKind, number>;
    actions: Record<Access, number>;
    cache: { hit: number; stale: number; miss: number; coalesced: number; stored: number; skipped: number; errors: number; waitTimeouts: number };
    budgetDenied: number;
  };
  blocked: Ring<BlockedVisit>;
  cacheOn: boolean;
  storeFor(ctx: Context): BotCacheStore;
  classify: Classifier;
  /** Cache keys (without vary parts) of a URL, for every access that is cached. */
  keysOf(url: URL): string[];
  get(): Live;
  set(v: Omit<Live, "ttl"> & { ttl?: number }): void;
}

interface SettingsValue {
  policy: Record<VisitorKind, Access>;
  blockCountries: string[];
  allowCountries: string[];
  botScoreThreshold: number;
  cacheTtl?: number;
}

/** The path part of a cache key `GET:<access>:<host><path>[?query][|...]`. */
function pathOfKey(key: string): string {
  const rest = key.slice(key.indexOf(":", 4) + 1);
  const at = rest.indexOf("/");
  return at === -1 ? "" : rest.slice(at);
}

const plural = (n: number) => `${n} cached response${n === 1 ? "" : "s"}`;
const upper = (list: string[]) => [...new Set(list.map((c) => c.toUpperCase()))];

export function botsManage(s: BotsManageState): ManageSection[] {
  const { counters } = s;
  const countries = t.array(t.string({ pattern: COUNTRY }), { max: 300, description: 'Two-letter ISO codes, e.g. ["US", "VN"] ("T1" is Tor).' });
  const policyShape: Record<VisitorKind, ReturnType<typeof t.enum<typeof ACTIONS>>> = {} as never;
  for (const k of KINDS) policyShape[k] = t.enum(ACTIONS);
  const schema = t.object({
    policy: t.object(policyShape),
    blockCountries: countries,
    allowCountries: t.array(t.string({ pattern: COUNTRY }), { max: 300, description: "When not empty, other countries are blocked. Empty: no restriction." }),
    botScoreThreshold: t.integer({ min: 1, max: 99, description: "Cloudflare bot scores below this are bots." }),
    ...(s.cacheOn ? { cacheTtl: t.integer({ min: 1, description: "Seconds a response cached for bots stays fresh (new entries)." }) } : {}),
  });

  const enumerable = (ctx: Context) => {
    const store = s.storeFor(ctx);
    if (!store.purge) throw errors.badRequest(`The ${store.name} bot cache store cannot list its entries`, "Purge single pages with purgeUrl, or wait for entries to expire (cache.ttl).");
    return store.purge.bind(store);
  };
  const needCache = () => {
    if (!s.cacheOn) throw errors.badRequest("The bot cache is off", "Enable it with bots({ cache: { ... } }) to cache responses for bots.");
  };

  return [
    {
      id: "bots",
      title: "Bots",
      description: "Who visits (humans, search engines, AI crawlers, bots), what they get, and the bot cache.",
      status(ctx) {
        const c = counters.cache;
        const stats: ManageStat[] = [{ label: "Blocked", value: counters.actions.block, hint: "Requests blocked by this instance since it started." }];
        if (!s.cacheOn) {
          stats.push({ label: "Cache store", value: "off" });
        } else {
          const store = s.storeFor(ctx);
          const reads = c.hit + c.miss;
          stats.push(
            { label: "Cache store", value: store.name },
            store.size ? { label: "Cache entries", value: store.size() } : { label: "Cache entries", value: null, hint: `Entries are not countable on the ${store.name} store.` },
            store.bytes ? { label: "Cache size", value: store.bytes(), hint: "Approximate bytes held by this instance." } : { label: "Cache size", value: null, hint: `Size is not known on the ${store.name} store.` },
            { label: "Cache hits", value: c.hit, hint: `Including ${c.coalesced} served from a request already in flight.` },
            { label: "Cache misses", value: c.miss },
            { label: "Hit rate", value: reads ? `${Math.round((c.hit / reads) * 100)}%` : "n/a" },
            { label: "Stale served", value: c.stale, hint: "Served stale while one request refreshed it (staleWhileRevalidate)." },
            { label: "Stored", value: c.stored },
            { label: "Not stored", value: c.skipped, hint: "Responses that could not be cached (status, cookies, private, too large...)." },
            { label: "Cache errors", value: c.errors, ...(c.errors ? { tone: "warning" as const } : {}) },
            { label: "Wait timeouts", value: c.waitTimeouts, hint: "Requests that stopped waiting for an in-flight request (cache.waitMs).", ...(c.waitTimeouts ? { tone: "warning" as const } : {}) },
          );
        }
        stats.push({ label: "Over budget", value: counters.budgetDenied, hint: "Requests denied by a budget limiter." });
        return {
          stats,
          tables: [
            { title: "Requests by kind", columns: [{ key: "kind", label: "Kind" }, { key: "requests", label: "Requests", type: "number" }], rows: KINDS.map((k) => ({ kind: k, requests: counters.kinds[k] })) },
            { title: "Decisions", columns: [{ key: "action", label: "Access" }, { key: "requests", label: "Requests", type: "number" }], rows: ACTIONS.map((a) => ({ action: a, requests: counters.actions[a] })) },
          ],
        };
      },
      settings: {
        schema,
        get(): SettingsValue {
          const live = s.get();
          const out: SettingsValue = { policy: { ...s.policy }, blockCountries: live.blockCountries, allowCountries: live.allowCountries, botScoreThreshold: live.botScoreThreshold };
          if (s.cacheOn) out.cacheTtl = live.ttl;
          return out;
        },
        set(v: SettingsValue) {
          Object.assign(s.policy, v.policy);
          s.set({ blockCountries: upper(v.blockCountries), allowCountries: upper(v.allowCountries), botScoreThreshold: v.botScoreThreshold, ttl: s.cacheOn ? v.cacheTtl : undefined });
        },
      },
      lists: [
        {
          name: "blocked",
          title: "Recently blocked",
          columns: [
            { key: "at", label: "Time", type: "date" },
            { key: "kind", label: "Kind" },
            { key: "name", label: "Agent" },
            { key: "country", label: "Country" },
            { key: "path", label: "Path", type: "code" },
            { key: "reason", label: "Reason" },
          ],
          idKey: "at",
          searchable: true,
          filters: [{ key: "kind", label: "Kind", options: [...KINDS] }],
          list(q) {
            const kind = q.filters?.kind;
            const needle = q.search?.toLowerCase();
            const all = s.blocked.newest().filter((b) => (!kind || b.kind === kind) && (!needle || [b.name, b.country, b.path].some((x) => x?.toLowerCase().includes(needle))));
            const start = q.cursor ? Number(q.cursor) || 0 : 0;
            const limit = Math.max(1, Math.min(q.limit, PAGE));
            const rows: Record<string, ManageValue>[] = all.slice(start, start + limit).map((b) => ({ ...b, at: new Date(b.at).toISOString() }));
            return start + limit < all.length ? { rows, next: String(start + limit) } : { rows };
          },
        },
      ],
      actions: [
        {
          name: "purgeCache",
          title: "Purge the bot cache",
          description: "Delete cached responses, all or under a path prefix. Needs a store that can list entries (the memory store).",
          danger: true,
          input: t.object({ pathPrefix: t.optional(t.string({ pattern: /^\//, description: 'E.g. "/blog/". Empty: everything.' })) }),
          async run(input: { pathPrefix?: string }, ctx) {
            needCache();
            const purge = enumerable(ctx);
            const prefix = input.pathPrefix;
            const n = await purge(prefix ? (k) => pathOfKey(k).startsWith(prefix) : undefined);
            return prefix ? `Purged ${plural(n)} under ${JSON.stringify(prefix)}.` : `Purged ${plural(n)}.`;
          },
        },
        {
          name: "purgeUrl",
          title: "Purge one page",
          description: "Delete the cached copies of one URL. Works on every store. Entries varied by country or varyBy are only found on the memory store.",
          input: t.object({ url: t.string({ format: "url" }) }),
          async run(input: { url: string }, ctx) {
            needCache();
            const store = s.storeFor(ctx);
            const keys = s.keysOf(new URL(input.url));
            let n = 0;
            if (store.purge) {
              const set = new Set(keys);
              n = await store.purge((k) => {
                const bar = k.indexOf("|");
                return set.has(bar === -1 ? k : k.slice(0, bar));
              });
            } else {
              if (!store.delete) throw errors.badRequest(`The ${store.name} bot cache store cannot delete entries`, "Wait for entries to expire (cache.ttl).");
              for (const k of keys) {
                if ((await store.get(k, ctx)) === undefined) continue;
                await store.delete(k, ctx);
                n++;
              }
            }
            return `Purged ${plural(n)} of ${input.url}.`;
          },
        },
        {
          name: "classifyUserAgent",
          title: "Test a User-Agent",
          description: "What a User-Agent claims to be, and the access that kind gets under the current policy. Without Cloudflare or your verify hook nothing is verified.",
          input: t.object({ userAgent: t.string({ maxLength: 2048 }) }),
          run(input: { userAgent: string }) {
            const ua = s.classify(input.userAgent);
            const kind: VisitorKind = ua.kind === "ai" || ua.kind === "bot" ? ua.kind : ua.kind === "search" ? "bot" : ua.kind === "browser" ? "human" : "unknown";
            const out: Record<string, unknown> = { kind, ...(ua.name ? { name: ua.name } : {}), verified: false, access: s.policy[kind] };
            if (ua.kind === "search") out.note = `Claims to be a search engine: counted as search (access ${s.policy.search}) only when Cloudflare or your verify hook confirms it.`;
            if (ua.kind === "browser") out.note = "A browser User-Agent: human when the request also has the headers browsers send.";
            return out;
          },
        },
      ],
    },
  ];
}
