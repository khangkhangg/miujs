// audit().manage(): the audit log in @miujs/admin. Read only: the log is append-only (rows are
// never edited, and only purgeOlderThan removes old ones, keeping the chain verifiable), so the
// section offers no delete. Filters go through the store's indexed query; nothing scans the log.
import { errors, t, type Context, type Env, type ManageSection, type ManageStat, type ManageValue } from "miujs";
import type { AuditQuery, AuditRecord, AuditStore } from "./store.ts";

const PAGE_MAX = 100;
/** Most entries one export returns. */
export const EXPORT_MAX = 1000;
const HOUR = 3_600_000;
const RANGES: Record<string, number> = { "1h": HOUR, "24h": 24 * HOUR, "7d": 7 * 24 * HOUR, "30d": 30 * 24 * HOUR };
const SEARCH_KEYS: Record<string, keyof AuditQuery> = { actor: "actor", action: "action", resource: "resource", id: "resourceId", resourceId: "resourceId", org: "org", since: "since", until: "until" };

export interface AuditManageDeps {
  store: AuditStore;
  /** True when appends are HMAC-signed (a key in options, the store or the env). */
  keyed(env: Env): boolean;
  /** The active organization of the request, if any (from @miujs/access). */
  orgOf(ctx: Context): string | null;
}

const iso = (ms: number) => new Date(ms).toISOString();
const toMs = (v: unknown): number => (typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : Date.parse(String(v)));

const orgMismatch = () =>
  errors.custom({
    code: "MIU_E_AUDIT_ORG_MISMATCH",
    status: 403,
    message: "You can only read the audit log of the active organization",
    fix: "Drop the org filter, or select that organization (x-org-id) if you belong to it.",
  });

/** Like GET /audit: with an active organization, only its entries. */
function scope(q: AuditQuery, ctx: Context, d: AuditManageDeps): AuditQuery {
  const active = d.orgOf(ctx);
  if (!active) return q;
  if (q.org !== undefined && q.org !== active) throw orgMismatch();
  return { ...q, org: active };
}

/** `actor:alice action:update since:2026-01-01 contacts` -> a query. A bare word is a resource. */
function parseSearch(search: string | undefined): AuditQuery {
  const q: Record<string, string> = {};
  for (const term of (search ?? "").trim().split(/\s+/).filter(Boolean)) {
    const i = term.indexOf(":");
    const key = i === -1 ? "resource" : term.slice(0, i);
    const value = i === -1 ? term : term.slice(i + 1);
    const field = Object.prototype.hasOwnProperty.call(SEARCH_KEYS, key) ? SEARCH_KEYS[key] : undefined;
    if (!field || value === "") {
      throw errors.badRequest(`Unknown search term ${JSON.stringify(term.slice(0, 100))}`, "Search with actor:, action:, resource:, id:, org:, since: and until: (ISO date or epoch ms), e.g. `actor:alice action:update`. A bare word matches the resource.");
    }
    q[field] = value.slice(0, 200);
  }
  return q as AuditQuery;
}

function changedFields(r: AuditRecord): string | null {
  return r.changes ? Object.keys(r.changes).sort().join(", ") : null;
}

function exportRow(r: AuditRecord) {
  return {
    seq: r.seq,
    ts: iso(r.ts),
    actor: r.actor,
    action: r.action,
    resource: r.resource,
    resourceId: r.resourceId,
    org: r.org,
    ip: r.ip,
    userAgent: r.userAgent,
    requestId: r.requestId,
    changes: r.changes,
    metadata: r.metadata,
    keyId: r.keyId ?? null,
    hash: r.hash,
  };
}

/** A CSV cell. Cells a spreadsheet would run as a formula (=, +, -, @, tab, CR) get a leading quote. */
function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = typeof v === "object" ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: ReturnType<typeof exportRow>[]): string {
  const cols = ["seq", "ts", "actor", "action", "resource", "resourceId", "org", "ip", "userAgent", "requestId", "changes", "metadata", "keyId", "hash"] as const;
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
}

export function auditManage(d: AuditManageDeps): ManageSection[] {
  const { store } = d;
  return [
    {
      id: "audit",
      title: "Audit log",
      description: "Who did what, and when. Append-only: entries cannot be edited or deleted here (retention is purgeOlderThan, which keeps the chain verifiable).",
      async status(ctx) {
        const head = await store.head(ctx.env);
        let recent = 0;
        if (head) {
          const first = await store.firstSeqSince(Date.now() - 24 * HOUR, ctx.env);
          recent = first === null ? 0 : head.seq - first + 1;
        }
        const keyed = d.keyed(ctx.env);
        const stats: ManageStat[] = [
          { label: "Last 24 h", value: recent, hint: "Entries written in the last 24 hours, counted by sequence number (all organizations)." },
          { label: "Entries", value: head?.seq ?? 0, hint: "Sequence number of the newest entry: every entry ever written, including purged ones." },
          { label: "Latest entry", value: head ? iso(head.ts) : null },
          keyed
            ? { label: "Signed", value: true, hint: "Entries are HMAC-signed: database access alone cannot rewrite the chain." }
            : { label: "Signed", value: false, tone: "warning", hint: "No HMAC key: anyone with database write access can rewrite the log and recompute its hashes. Set AUDIT_HMAC_KEY." },
          { label: "Store", value: store.kind },
        ];
        return { stats };
      },
      lists: [
        {
          name: "log",
          title: "Entries",
          columns: [
            { key: "seq", label: "#", type: "number" },
            { key: "ts", label: "Time", type: "date" },
            { key: "actor", label: "Actor", type: "code" },
            { key: "action", label: "Action" },
            { key: "resource", label: "Resource" },
            { key: "resourceId", label: "Resource id", type: "code" },
            { key: "org", label: "Org", type: "code" },
            { key: "changed", label: "Changed fields" },
            { key: "ip", label: "IP", type: "code" },
            { key: "requestId", label: "Request", type: "code" },
          ],
          idKey: "seq",
          searchable: true,
          filters: [{ key: "range", label: "Time", options: Object.keys(RANGES) }],
          async list(q, ctx) {
            const query = parseSearch(q.search);
            const range = q.filters?.range;
            if (range) {
              const span = Object.prototype.hasOwnProperty.call(RANGES, range) ? RANGES[range] : undefined;
              if (span === undefined) throw errors.badRequest(`Unknown range ${JSON.stringify(range)}`, `Use one of: ${Object.keys(RANGES).join(", ")}.`);
              const since = Date.now() - span;
              // A since: in the search and the range both apply: the later one wins.
              if (query.since === undefined || !(toMs(query.since) > since)) query.since = since;
            }
            const limit = Math.max(1, Math.min(PAGE_MAX, Math.trunc(q.limit) || PAGE_MAX));
            const page = await store.query(scope({ ...query, limit, cursor: q.cursor }, ctx, d), ctx.env);
            const rows: Record<string, ManageValue>[] = page.items.map((r) => ({
              seq: r.seq,
              ts: iso(r.ts),
              actor: r.actor,
              action: r.action,
              resource: r.resource,
              resourceId: r.resourceId,
              org: r.org,
              changed: changedFields(r),
              ip: r.ip,
              requestId: r.requestId,
            }));
            return page.nextCursor ? { rows, next: page.nextCursor } : { rows };
          },
        },
      ],
      actions: [
        {
          name: "export",
          title: "Export entries",
          description: `Download matching entries (newest first, at most ${EXPORT_MAX}) as JSON or CSV, with their hashes for offline checks.`,
          input: t.object({
            actor: t.optional(t.string({ maxLength: 200 })),
            action: t.optional(t.string({ maxLength: 200 })),
            resource: t.optional(t.string({ maxLength: 200 })),
            resourceId: t.optional(t.string({ maxLength: 200 })),
            org: t.optional(t.string({ maxLength: 200 })),
            since: t.optional(t.string({ maxLength: 40, description: "ISO date or epoch ms (inclusive)" })),
            until: t.optional(t.string({ maxLength: 40, description: "ISO date or epoch ms (exclusive)" })),
            format: t.optional(t.enum(["json", "csv"])),
            limit: t.optional(t.integer({ min: 1, max: EXPORT_MAX })),
          }),
          async run(input: AuditQuery & { format?: "json" | "csv"; limit?: number }, ctx) {
            const { format = "json", limit = EXPORT_MAX, ...filters } = input;
            const page = await store.query(scope({ ...filters, limit }, ctx, d), ctx.env);
            const rows = page.items.map(exportRow);
            const truncated = page.nextCursor !== null;
            const n = rows.length;
            const message = `Exported ${n} ${n === 1 ? "entry" : "entries"}${truncated ? `; more match: narrow the filters or set until to ${iso(page.items[n - 1].ts)} for the next batch` : ""}.`;
            return { format, count: n, truncated, data: format === "csv" ? toCsv(rows) : rows, message };
          },
        },
      ],
    },
  ];
}
