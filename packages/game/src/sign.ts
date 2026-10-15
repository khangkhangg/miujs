// HMAC-SHA256 signed tokens (web crypto only): match tickets, signed room results and score
// proofs. Format: base64url(JSON payload) "." base64url(signature). Every payload carries a
// `k` (kind) so a token minted for one purpose is never accepted for another.

import { detectRuntime, processEnv, type Runtime } from "miujs";
import { gameErrors } from "./errors.ts";
import { equalBytes, hmacSha256 } from "./sha256.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const keys = new Map<string, Promise<CryptoKey>>();

function key(secret: string): Promise<CryptoKey> {
  let k = keys.get(secret);
  if (!k) {
    k = crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    keys.set(secret, k);
  }
  return k;
}

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** HMAC-SHA256 of `data`, base64url. */
export async function hmac(secret: string, data: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), enc.encode(data))));
}

/** Constant-time check of an `hmac()` value. */
export async function hmacVerify(secret: string, data: string, sig: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sig)) return false;
  return crypto.subtle.verify("HMAC", await key(secret), fromB64url(sig), enc.encode(data));
}

/** Sign `payload` as a token of `kind`. Put the expiry (ms since epoch) in `exp`. */
export async function signToken(secret: string, kind: string, payload: Record<string, unknown>): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify({ k: kind, ...payload })));
  return `${body}.${await hmac(secret, body)}`;
}

/** Verify a token of `kind`; returns its payload. Throws MIU_E_GAME_TICKET_INVALID / _EXPIRED. */
export async function verifyToken<T = Record<string, unknown>>(secret: string, kind: string, token: unknown, now: number): Promise<T> {
  if (typeof token !== "string" || token.length > 4096) throw gameErrors.ticketInvalid("not a token");
  const dot = token.indexOf(".");
  if (dot <= 0) throw gameErrors.ticketInvalid("malformed");
  const body = token.slice(0, dot);
  if (!(await hmacVerify(secret, body, token.slice(dot + 1)))) throw gameErrors.ticketInvalid("bad signature");
  return readPayload<T>(body, kind, now);
}

/** Synchronous `verifyToken` (pure-JS HMAC), for synchronous hooks such as `onJoinRequest`. */
export function verifyTokenSync<T = Record<string, unknown>>(secret: string, kind: string, token: unknown, now: number): T {
  if (typeof token !== "string" || token.length > 4096) throw gameErrors.ticketInvalid("not a token");
  const dot = token.indexOf(".");
  if (dot <= 0) throw gameErrors.ticketInvalid("malformed");
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let given: Uint8Array;
  try {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sig)) throw 0;
    given = fromB64url(sig);
  } catch {
    throw gameErrors.ticketInvalid("bad signature");
  }
  if (!equalBytes(hmacSha256(enc.encode(secret), enc.encode(body)), given)) throw gameErrors.ticketInvalid("bad signature");
  return readPayload<T>(body, kind, now);
}

function readPayload<T>(body: string, kind: string, now: number): T {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(dec.decode(fromB64url(body)));
  } catch {
    throw gameErrors.ticketInvalid("malformed");
  }
  if (!payload || payload.k !== kind) throw gameErrors.ticketInvalid(`not a ${kind} token`);
  if (typeof payload.exp === "number" && now >= payload.exp) throw gameErrors.ticketExpired();
  const { k: _k, ...rest } = payload;
  return rest as T;
}

// ---- secrets --------------------------------------------------------------------------------

let devSecret: string | null = null;

/**
 * The secret used to sign tickets. Explicit option, else `MIU_GAME_SECRET` from the env. Off
 * Workers, a random per-process secret is used as a dev fallback (matchmaker and rooms in the
 * same process agree on it); on Workers a missing secret is an error.
 */
export function gameSecret(explicit?: string, where: { env?: Record<string, unknown>; runtime?: Runtime } = {}): string {
  const runtime = where.runtime ?? detectRuntime();
  const env = where.env ?? (runtime === "workerd" ? {} : processEnv());
  const s = explicit ?? (typeof env.MIU_GAME_SECRET === "string" ? env.MIU_GAME_SECRET : undefined);
  if (s !== undefined) {
    if (s.length < 16) throw gameErrors.secretWeak();
    return s;
  }
  if (runtime === "workerd") throw gameErrors.secretMissing();
  if (!devSecret) {
    const b = new Uint8Array(32);
    crypto.getRandomValues(b);
    devSecret = b64url(b);
  }
  return devSecret;
}

/**
 * `gameSecret()` that also reads `MIU_GAME_SECRET` from a Worker / Durable Object / room env
 * (`ctx.env`, the object's `env`, `room.env`). Workers have no process env, so without this the
 * secret set with `wrangler secret put MIU_GAME_SECRET` was never found there.
 */
export function gameSecretFor(explicit: string | undefined, env: Record<string, unknown> | undefined): string {
  if (explicit === undefined && typeof env?.MIU_GAME_SECRET === "string") return gameSecret(env.MIU_GAME_SECRET);
  return gameSecret(explicit);
}

// ---- tickets --------------------------------------------------------------------------------

export interface TicketClaims {
  userId: string;
  /** Display name to seat the player with. */
  name: string;
  roomType: string;
  roomId: string;
  /** Match (or lobby) the seat belongs to. */
  matchId: string;
  team: number;
}

export interface Ticket extends TicketClaims {
  exp: number;
}

/** A short-lived signed ticket that lets `userId` take a seat in one room. */
export async function issueTicket(secret: string, claims: TicketClaims, now: number, ttlMs = 60_000): Promise<string> {
  return signToken(secret, "ticket", { u: claims.userId, n: claims.name, rt: claims.roomType, r: claims.roomId, m: claims.matchId, tm: claims.team, exp: now + ttlMs });
}

/** Verify a ticket for this room. `allowExpired` accepts a genuine but expired ticket (reconnects). */
export async function verifyTicket(secret: string, token: unknown, where: TicketWhere): Promise<Ticket> {
  return toTicket(await verifyToken<RawTicket>(secret, "ticket", token, where.allowExpired ? -Infinity : where.now), where);
}

/** Synchronous `verifyTicket` (used by gameRoom's onJoinRequest). */
export function verifyTicketSync(secret: string, token: unknown, where: TicketWhere): Ticket {
  return toTicket(verifyTokenSync<RawTicket>(secret, "ticket", token, where.allowExpired ? -Infinity : where.now), where);
}

interface TicketWhere {
  roomType: string;
  roomId: string;
  now: number;
  allowExpired?: boolean;
}

type RawTicket = { u: string; n: string; rt: string; r: string; m: string; tm: number; exp: number };

function toTicket(p: RawTicket, where: TicketWhere): Ticket {
  if (p.rt !== where.roomType || p.r !== where.roomId) throw gameErrors.ticketInvalid("issued for another room");
  return { userId: p.u, name: p.n, roomType: p.rt, roomId: p.r, matchId: p.m, team: p.tm, exp: p.exp };
}
