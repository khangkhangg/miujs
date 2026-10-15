// The session plugin's admin section: storage and secret status, active sessions, revocation.
// Session ids are secrets: the admin sees a short SHA-256 prefix, and rows carry an encrypted
// reference (AES-GCM, key derived from the session secret) that only the server can open.

import { errors, t, type Context, type ManageSection, type ManageStat } from "miujs";
import { base64urlDecode, base64urlEncode, hex, randomBytes, sha256, utf8 } from "./crypto.ts";
import type { SessionStore } from "./stores.ts";

/** @internal What the plugin shares with its admin section. */
export interface SessionManageState {
  store: SessionStore | undefined;
  csrf: boolean;
  getMaxAge(): number;
  setMaxAge(seconds: number): void;
  /** The signing secrets for this request (first signs). */
  secretsFor(ctx: Context): string[];
  /** "configured" | "random (dev)" etc. Never the secret. */
  secretSource(ctx: Context): { value: string; tone?: ManageStat["tone"] };
}

const PAGE = 100;
const COUNT_CAP = 10_000;

/** `7d`, `1h`, `90m` or `45s`. */
export function duration(seconds: number): string {
  for (const [unit, n] of [["d", 86_400], ["h", 3600], ["m", 60]] as const) if (seconds % n === 0) return `${seconds / n}${unit}`;
  return `${seconds}s`;
}

const keys = new Map<string, Promise<CryptoKey>>();
function refKey(secret: string): Promise<CryptoKey> {
  let k = keys.get(secret);
  if (!k) {
    k = crypto.subtle
      .importKey("raw", utf8(secret), "HKDF", false, ["deriveKey"])
      .then((base) => crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: utf8("miu-session-admin"), info: utf8("row-ref") }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]));
    keys.set(secret, k);
  }
  return k;
}

async function sealRef(id: string, secret: string): Promise<string> {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await refKey(secret), utf8(id)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return base64urlEncode(out);
}

async function openRef(ref: string, secrets: string[]): Promise<string | null> {
  const bytes = base64urlDecode(ref);
  if (!bytes || bytes.length < 13) return null;
  for (const s of secrets) {
    try {
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, await refKey(s), bytes.slice(12));
      return new TextDecoder().decode(pt);
    } catch {
      // wrong key: try the next (rotated) secret
    }
  }
  return null;
}

/** What the admin shows instead of a session id. */
export const sessionHash = async (id: string): Promise<string> => hex(await sha256(id)).slice(0, 12);

export function sessionManage(s: SessionManageState): ManageSection[] {
  const { store } = s;
  const need = <K extends "list" | "deleteUser">(what: K): NonNullable<SessionStore[K]> => {
    if (!store) {
      throw errors.badRequest(
        "Cookie sessions live only in browsers: they cannot be listed or revoked one by one",
        "To sign everyone out, rotate SESSION_SECRET. To revoke single sessions, use a server store: session({ store: dbSessionStore(db) }).",
      );
    }
    const fn = store[what];
    if (!fn) {
      throw errors.badRequest(
        what === "list" ? `The ${store.kind} session store cannot list sessions` : `The ${store.kind} session store cannot find sessions by user`,
        "Use dbSessionStore() (SQLite / D1) or memorySessionStore() for this, or rotate SESSION_SECRET to sign everyone out.",
      );
    }
    return fn.bind(store) as NonNullable<SessionStore[K]>;
  };

  return [
    {
      id: "sessions",
      title: "Sessions",
      description: "Where sessions live, who is signed in, and revoking sessions.",
      async status(ctx) {
        let active: ManageStat;
        if (store?.count) {
          const n = await store.count(ctx.env, COUNT_CAP + 1);
          active = { label: "Active sessions", value: n > COUNT_CAP ? `${COUNT_CAP}+` : n };
        } else {
          active = { label: "Active sessions", value: null, hint: store ? `Sessions are not countable on the ${store.kind} store.` : "Cookie sessions live in browsers and are not countable." };
        }
        const secret = s.secretSource(ctx);
        return {
          stats: [
            { label: "Storage", value: store ? store.kind : "cookie" },
            active,
            { label: "Max age", value: duration(s.getMaxAge()) },
            { label: "Secret", value: secret.value, ...(secret.tone ? { tone: secret.tone } : {}) },
            { label: "CSRF check", value: s.csrf, ...(s.csrf ? {} : { tone: "warning" as const }) },
          ],
        };
      },
      settings: {
        schema: t.object({ maxAge: t.integer({ min: 60, max: 400 * 86_400, description: "Seconds a session lives after its last change (browsers cap cookies at 400 days)." }) }),
        get: () => ({ maxAge: s.getMaxAge() }),
        set(value: { maxAge: number }) {
          s.setMaxAge(value.maxAge);
        },
      },
      lists: [
        {
          name: "sessions",
          title: "Active sessions",
          columns: [
            { key: "session", label: "Session", type: "code" },
            { key: "user", label: "User", type: "code" },
            { key: "expiresAt", label: "Expires", type: "date" },
          ],
          idKey: "ref",
          searchable: true,
          async list(q, ctx) {
            const list = need("list");
            const secret = s.secretsFor(ctx)[0];
            const page = await list({ cursor: q.cursor, limit: Math.max(1, Math.min(q.limit, PAGE)), userId: q.search || undefined }, ctx.env);
            const rows = await Promise.all(
              page.sessions.map(async (x) => ({ session: await sessionHash(x.id), user: x.userId, expiresAt: new Date(x.expiresAt).toISOString(), ref: await sealRef(x.id, secret) })),
            );
            return page.next ? { rows, next: page.next } : { rows };
          },
          rowActions: [
            {
              name: "revoke",
              title: "Revoke",
              description: "Sign this session out. Its browser gets a fresh, empty session on its next request.",
              danger: true,
              input: t.object({ id: t.string({ minLength: 1 }) }),
              async run(input: { id: string }, ctx) {
                need("list");
                const id = await openRef(input.id, s.secretsFor(ctx));
                if (id === null) throw errors.badRequest("Unknown session reference", "Reload the sessions list and try again (references change when the session secret rotates).");
                await store!.delete(id, ctx.env);
                return `Revoked session ${await sessionHash(id)}.`;
              },
            },
          ],
        },
      ],
      actions: [
        {
          name: "revokeUser",
          title: "Sign a user out everywhere",
          description: "Delete every session of one user (the userId that @miujs/auth stores in the session).",
          danger: true,
          input: t.object({ userId: t.string({ minLength: 1 }) }),
          async run(input: { userId: string }, ctx) {
            const n = await need("deleteUser")(input.userId, ctx.env);
            return `Revoked ${n} session${n === 1 ? "" : "s"} of user ${JSON.stringify(input.userId)}.`;
          },
        },
      ],
    },
  ];
}
