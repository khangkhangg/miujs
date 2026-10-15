// HTTP ticket gate for game-room WebSockets. Realtime rooms seat anyone who connects (there is no
// kick), so for game room types the matchmaker / lobbies plugins check the ticket on the upgrade
// request itself, before the room sees the connection:
//
//   GET /rooms/<type>/<id>?name=…&ticket=<ticket>     valid, unexpired ticket for this room → pass
//   GET /rooms/<type>/<id>?resume=<token>             pure resume (no name) → pass; the room checks the token
//   GET /rooms/<type>/<id>?resume=…&name=…&ticket=…   reconnect: ticket may be expired, must be genuine
//   anything else                                     401 MIU_E_GAME_TICKET_REQUIRED / _INVALID
//
// The in-room `ticket` message still binds the seat to the user (rooms cannot read the URL).

import type { Context } from "miujs";
import type { Clock } from "@miujs/realtime";
import { gameErrors } from "./errors.ts";
import { verifyTicket } from "./sign.ts";

const first = (v: unknown): string | undefined => (Array.isArray(v) ? (typeof v[0] === "string" ? v[0] : undefined) : typeof v === "string" ? v : undefined);

export function ticketGate(o: { roomsPath: string; types: () => Iterable<string>; secret: () => string; clock: Clock }) {
  const prefix = o.roomsPath.replace(/\/+$/, "");
  return async (ctx: Context): Promise<Response | void> => {
    if (!ctx.path.startsWith(prefix + "/")) return;
    const segs = ctx.path.slice(prefix.length + 1).split("/");
    if (segs.length !== 2) return;
    const type = decodeURIComponent(segs[0]);
    if (![...o.types()].includes(type)) return;
    const id = decodeURIComponent(segs[1]);
    const ticket = first(ctx.query.ticket);
    const resume = first(ctx.query.resume);
    if (ticket === undefined) {
      if (resume !== undefined && first(ctx.query.name) === undefined) return;
      return gameErrors.ticketRequired().toResponse();
    }
    try {
      await verifyTicket(o.secret(), ticket, { roomType: type, roomId: id, now: o.clock.now(), allowExpired: resume !== undefined });
    } catch (err) {
      return (err as { toResponse(): Response }).toResponse();
    }
  };
}
