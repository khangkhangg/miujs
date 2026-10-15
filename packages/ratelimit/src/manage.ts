// The rate limiter's admin section: rules and counters, live limits, limited clients, resets.

import { errors, isMiuError, t, type Context, type ManageSection } from "miujs";
import { checkPolicy, parseWindow, type Policy, type WindowSpec } from "./algorithms.ts";
import type { Compiled } from "./plugin.ts";
import type { RateLimitStore } from "./stores.ts";

/** @internal What the plugin shares with its admin section. */
export interface ManageState {
  rules: Compiled[];
  store: RateLimitStore;
  now: () => number;
  /** Throws when `store` cannot enforce `policy`. */
  checkStore(policy: Policy, where: string): void;
  counters: { rejected: number; storeErrors: number; rejectedBy: Map<string, number> };
}

const PAGE = 100;
const WINDOW = /^[1-9]\d*(ms|s|m|h|d)$/;

/** A window as the settings show it: `"1m"`, or `"30s"` for a number of seconds. */
const windowText = (w: WindowSpec): string => (typeof w === "number" ? `${w}s` : w.trim());

function matchText(d: Record<string, unknown>): string {
  if (typeof d.match === "string") return d.match;
  return Object.entries(d.match as Record<string, string[]>)
    .map(([k, v]) => `${k} ${v.join(", ")}`)
    .join("; ");
}

export function rateLimitManage(s: ManageState): ManageSection[] {
  const { rules, store, counters } = s;
  const names = rules.map((r) => r.name) as [string, ...string[]];

  const ruleNamed = (name: string): Compiled => {
    const rule = rules.find((r) => r.name === name);
    if (!rule) throw errors.badRequest(`No rule named ${JSON.stringify(name)}`, `Use one of: ${names.join(", ")}.`);
    return rule;
  };

  const reset = async (rule: Compiled, identity: string, ctx: Context): Promise<string> => {
    if (!store.reset) throw errors.badRequest(`The ${store.kind} store cannot reset keys`, "Wait for the window to pass, or use memoryStore(), kvStore(), durableObjectStore() or redisStore().");
    await store.reset(`${rule.name}:${identity}`, ctx.env, rule.policy, s.now());
    return `Reset ${JSON.stringify(identity)} for rule ${JSON.stringify(rule.name)}.`;
  };

  const ruleSchema = t.object({
    limit: t.integer({ min: 1, description: "Requests per window (token bucket: refill per window)." }),
    window: t.string({ pattern: WINDOW, description: 'Like "10s", "1m", "15m", "1h" or "1d".' }),
  });
  const shape: Record<string, typeof ruleSchema> = {};
  for (const n of names) shape[n] = ruleSchema;

  return [
    {
      id: "ratelimit",
      title: "Rate limits",
      description: "Rules, rejections, currently limited clients and live limits.",
      status() {
        const tracked = store.size
          ? { label: "Keys tracked", value: store.size(), hint: "Counters held by this instance (expired ones are swept lazily)." }
          : { label: "Keys tracked", value: null, hint: `Keys are not countable on the ${store.kind} store.` };
        return {
          stats: [
            { label: "Store", value: store.kind },
            { label: "Rules", value: rules.length },
            tracked,
            { label: "Rejected", value: counters.rejected, hint: "429 responses from this instance since it started.", ...(counters.rejected ? { tone: "warning" as const } : {}) },
            { label: "Store errors", value: counters.storeErrors, hint: "Store failures in this instance (see onStoreError).", ...(counters.storeErrors ? { tone: "critical" as const } : {}) },
          ],
          tables: [
            {
              title: "Rules",
              columns: [
                { key: "name", label: "Rule", type: "code" },
                { key: "match", label: "Match" },
                { key: "limit", label: "Limit", type: "number" },
                { key: "window", label: "Window" },
                { key: "algorithm", label: "Algorithm" },
                { key: "by", label: "By" },
                { key: "rejected", label: "Rejected", type: "number" },
              ],
              rows: rules.map((r) => {
                const d = r.describe();
                return { name: r.name, match: matchText(d), limit: r.policy.limit, window: windowText(r.windowSpec), algorithm: r.policy.algorithm, by: String(d.by), rejected: counters.rejectedBy.get(r.name) ?? 0 };
              }),
            },
          ],
        };
      },
      settings: {
        schema: t.object(shape),
        get() {
          const out: Record<string, { limit: number; window: string }> = {};
          for (const r of rules) out[r.name] = { limit: r.policy.limit, window: windowText(r.windowSpec) };
          return out;
        },
        async set(value: Record<string, { limit: number; window: string }>) {
          // Check every rule first so a bad one changes nothing.
          const next = rules.map((r) => {
            const v = value[r.name]; // the schema requires every rule
            const where = `rateLimit rule "${r.name}"`;
            let policy: Policy;
            try {
              policy = checkPolicy({ ...r.policy, limit: v.limit, windowMs: parseWindow(v.window) }, where);
              s.checkStore(policy, where);
            } catch (err) {
              // Operator input, not a deploy-time mistake: answer 400 with the same explanation.
              if (isMiuError(err)) throw errors.badRequest(err.message, err.fix);
              throw err;
            }
            return { policy, window: v.window };
          });
          rules.forEach((r, i) => {
            const n = next[i];
            r.policy = n.policy;
            r.windowSpec = n.window;
          });
        },
      },
      lists: [
        {
          name: "keys",
          title: "Limited clients",
          columns: [
            { key: "rule", label: "Rule", type: "code" },
            { key: "identity", label: "Client", type: "code" },
            { key: "limited", label: "Limited", type: "boolean" },
            { key: "expiresAt", label: "Forgotten at", type: "date" },
          ],
          idKey: "key",
          searchable: true,
          filters: [{ key: "state", label: "Show", options: ["limited", "all"] }],
          async list(q) {
            if (!store.scan) throw errors.badRequest(`The ${store.kind} store cannot list keys`, "Clients can be listed with memoryStore(); reset a known client with the resetKey action.");
            const page = await store.scan({
              cursor: q.cursor,
              limit: Math.max(1, Math.min(q.limit, PAGE)),
              now: s.now(),
              limitedOnly: q.filters?.state !== "all",
              search: q.search || undefined,
            });
            const rows = page.keys.map((k) => {
              const at = k.key.indexOf(":");
              return { key: k.key, rule: k.key.slice(0, at), identity: k.key.slice(at + 1), limited: k.limited, expiresAt: new Date(k.expiresAt).toISOString() };
            });
            return page.next ? { rows, next: page.next } : { rows };
          },
          rowActions: [
            {
              name: "reset",
              title: "Reset",
              description: "Forget this client's counter so it can send requests again.",
              input: t.object({ id: t.string({ minLength: 1 }) }),
              run(input: { id: string }, ctx) {
                const at = input.id.indexOf(":");
                return reset(ruleNamed(at === -1 ? input.id : input.id.slice(0, at)), input.id.slice(at + 1), ctx);
              },
            },
          ],
        },
      ],
      actions: [
        {
          name: "resetKey",
          title: "Reset a client",
          description: 'Forget one client\'s counter for a rule. Clients look like "ip:203.0.113.7", "user:<id>", "key:<hash>" or "fn:<value>".',
          input: t.object({ rule: t.enum(names), identity: t.string({ minLength: 1 }) }),
          run(input: { rule: string; identity: string }, ctx) {
            return reset(ruleNamed(input.rule), input.identity, ctx);
          },
        },
      ],
    },
  ];
}
