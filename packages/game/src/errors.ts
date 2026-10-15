// Every error the game kit raises: a stable MIU_E_GAME_* code, a message and a fix.

import { errors, type MiuError } from "miujs";

const e = (code: string, status: number, message: string, fix: string, details?: unknown): MiuError => errors.custom({ code, status, message, fix, details });

export const gameErrors = {
  secretMissing: () =>
    errors.config(
      "MIU_E_GAME_SECRET_MISSING",
      "No game secret: tickets and result signatures need one on Cloudflare Workers",
      "Set the MIU_GAME_SECRET variable (wrangler secret put MIU_GAME_SECRET) or pass { secret } to matchmaker()/gameRoom()/lobbies(). Use 32+ random characters.",
    ),
  secretWeak: () =>
    errors.config("MIU_E_GAME_SECRET_WEAK", "The game secret must be at least 16 characters", "Use 32+ random characters, e.g. crypto.randomUUID() + crypto.randomUUID()."),
  ticketInvalid: (why: string) =>
    e("MIU_E_GAME_TICKET_INVALID", 401, `Ticket rejected: ${why}`, "Use the ticket the matchmaker or lobby gave you for this room (GET /match/:queue/status); do not edit it."),
  ticketExpired: () =>
    e("MIU_E_GAME_TICKET_EXPIRED", 401, "Ticket expired", "Tickets are short-lived: connect to the room right after you are matched, or ask the matchmaker/lobby for a fresh ticket."),
  ticketRequired: () =>
    e(
      "MIU_E_GAME_TICKET_REQUIRED",
      401,
      "Present your match ticket before playing",
      'Connect with ?ticket=<ticket> and send {"t":"msg","type":"ticket","data":{"ticket":"<ticket>"}} right after the welcome frame (the ticket comes with the match).',
    ),
  ticketUsed: () =>
    e("MIU_E_GAME_TICKET_USED", 409, "This user is already seated in the room as another player", "Reconnect with your resumeToken instead of joining again."),
  queueUnknown: (queue: string, known: string[]) =>
    e("MIU_E_GAME_QUEUE_UNKNOWN", 404, `No matchmaking queue "${queue}"`, `Use one of: ${known.join(", ") || "(none)"}, or add it to matchmaker({ queues }).`),
  queueConfig: (message: string, fix: string) => errors.config("MIU_E_GAME_QUEUE_CONFIG", message, fix),
  roomConfig: (message: string, fix: string) => errors.config("MIU_E_GAME_ROOM_CONFIG", message, fix),
  alreadyQueued: (queue: string) =>
    e("MIU_E_GAME_ALREADY_QUEUED", 409, `You are already waiting in "${queue}"`, `Poll GET /match/${queue}/status, or DELETE /match/${queue}/leave first.`),
  regionRequired: (regions: string[]) =>
    e("MIU_E_GAME_REGION_INVALID", 400, "This queue needs a valid region", `Send { "region": one of ${regions.join(", ")} } in the join body.`),
  lobbyNotFound: () => e("MIU_E_GAME_LOBBY_NOT_FOUND", 404, "No such lobby (or its code expired)", "Check the 6-digit code, or create a new lobby with POST /lobbies."),
  lobbyFull: (max: number) => e("MIU_E_GAME_LOBBY_FULL", 409, `Lobby is full (${max} players)`, "Join another lobby or ask the host to start a new one."),
  lobbyNotMember: () => e("MIU_E_GAME_LOBBY_NOT_MEMBER", 403, "You are not in this lobby", "Join it first: POST /lobbies/join with its code."),
  lobbyNotHost: () => e("MIU_E_GAME_LOBBY_NOT_HOST", 403, "Only the lobby host can start the match", "Ask the host to start, or create your own lobby."),
  lobbyNotReady: (missing: string[], min: number) =>
    e("MIU_E_GAME_LOBBY_NOT_READY", 409, `Cannot start: ${missing.length ? `not ready: ${missing.join(", ")}` : `need at least ${min} players`}`, "Every member must POST /lobbies/:id/ready with { ready: true }, and the lobby needs enough players."),
  lobbyStarted: () => e("MIU_E_GAME_LOBBY_STARTED", 409, "The lobby already started its match", "Connect to the room from GET /lobbies/:id, or create a new lobby."),
  matchUnknown: (id: string) => e("MIU_E_GAME_MATCH_UNKNOWN", 404, `No match "${id}"`, "Report results with the match id the room was created with (room.secret / seat info)."),
  resultInvalid: (why: string) =>
    e("MIU_E_GAME_RESULT_INVALID", 400, `Invalid match result: ${why}`, "Pass { winners: [userIds] } or { ranking: [[userIds], ...] } using only players of this match."),
  resultUnsigned: () =>
    e("MIU_E_GAME_RESULT_UNSIGNED", 401, "Match results must come from the room server", "Results are only accepted from the authoritative room: call reportResult() server-side or sign the request with signResult(secret, body)."),
  scoreInvalid: (why: string) => e("MIU_E_GAME_SCORE_INVALID", 400, `Score rejected: ${why}`, "Submit a finite number between the leaderboard's minScore and maxScore."),
  scoreRateLimited: (perMinute: number) =>
    e("MIU_E_GAME_SCORE_RATE_LIMITED", 429, "Too many score submissions", `Submit at most ${perMinute} scores per minute per player.`),
  clientScoresDisabled: (id: string) =>
    e(
      "MIU_E_GAME_CLIENT_SCORES_DISABLED",
      403,
      `Leaderboard "${id}" does not accept scores from clients`,
      "Submit scores from the room (board.submit(playerId, score) on the server), or enable clientSubmit: { secret } and send a signed proof.",
    ),
  proofInvalid: () =>
    e("MIU_E_GAME_PROOF_INVALID", 401, "Score proof is missing or does not match", "Sign the score server-side with signScoreProof(secret, { board, playerId, score, nonce }) and send it as `proof`."),
  leaderboardConfig: (message: string, fix: string) => errors.config("MIU_E_GAME_LEADERBOARD_CONFIG", message, fix),
  timezoneInvalid: (tz: string) => errors.config("MIU_E_GAME_TIMEZONE_INVALID", `Unknown time zone "${tz}"`, 'Use an IANA zone name such as "UTC", "Europe/Paris" or "America/Los_Angeles".'),
  playerNotFound: (id: string) => e("MIU_E_GAME_PLAYER_NOT_FOUND", 404, `No player "${id}"`, "Players are created on first matchmaking join or with store.ensurePlayer(id, name)."),
  loopDurable: () =>
    e(
      "MIU_E_GAME_LOOP_NOT_DURABLE",
      500,
      "fixedStep(room, hz, update) uses a closure, which cannot survive Durable Object hibernation",
      'Use fixedStep.define("step", { hz, update }) and spread its .timers into defineRoom({ timers }); it re-arms with room.schedule().',
    ),
  achievementInvalid: (id: string) =>
    errors.config("MIU_E_GAME_ACHIEVEMENT_INVALID", `Achievement "${id}" is invalid`, "Each achievement needs an id of letters, digits, _ . or - and { title: string, check: (stats) => boolean }."),
  storeMissing: (what: string) =>
    errors.config("MIU_E_GAME_STORE_MISSING", `${what} needs a game store`, "Pass { store: gameStore({ database }) } (SQLite locally, D1 on Workers)."),
};
