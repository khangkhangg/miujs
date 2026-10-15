// @miujs/game: matchmaking, lobbies, ratings, leaderboards, achievements and game-loop helpers
// on top of @miujs/realtime. See README.md.

export { AchievementSet, defineAchievements, type AchievementDef, type PlayerStats, type Unlock } from "./achievements.ts";
export { createMatchmakerDurableObject, durableHost, type MatchHost, type MatchmakerDurableObject, type MatchmakerDurableObjectClass, type MatchmakerDurableObjectOptions } from "./cloudflare.ts";
export { defaultDatabase } from "./db.ts";
export { gameErrors } from "./errors.ts";
export { leaderboard, periodKey, signScoreProof, type Entry, type Leaderboard, type LeaderboardOptions, type Resets, type SubmitResult } from "./leaderboard.ts";
export { createLobbyDurableObject, execLobby, lobbies, type Lobbies, type LobbyDurableObject, type LobbyDurableObjectClass, type LobbiesOptions, type LobbyReply, type LobbyRequest } from "./lobbies.ts";
export { LobbyCore, type LobbyInit, type LobbySnapshot, type LobbyStatus, type LobbyView } from "./lobby.ts";
export {
  acceptInput,
  ackedSeqs,
  createInputState,
  dropInputs,
  fixedStep,
  lerpState,
  predictor,
  processInputs,
  snapshotInterpolation,
  type FixedStepOptions,
  type InputState,
  type InputVerdict,
  type Interpolator,
  type Predictor,
  type StepContext,
  type StepFn,
} from "./loop.ts";
export { matchmaker, resultReporter, signResult, type Matchmaker, type MatchmakerOptions, type RoomsLike } from "./matchmaker.ts";
export { profiles, type ProfilesOptions } from "./profiles.ts";
export { QueueCore, checkQueueConfig, type Assignment, type MatchPlayer, type MatchSpec, type QueueConfig, type QueueEntry, type QueueSnapshot, type QueueStatus, type RatingSystem, type RoomRef } from "./queue.ts";
export { DEFAULT_K, DEFAULT_RATING, eloExpected, eloMatch, eloUpdate, glicko2Match, glicko2Update, type Glicko, type Outcome } from "./rating.ts";
export { gameRoom, matchOf, reportResult, seatOf, seats, type GameInitContext, type GameRoomData, type GameRoomDefinition, type GameRoomOptions, type MatchInfo, type Seat } from "./room.ts";
export { gameSecret, gameSecretFor, issueTicket, signToken, verifyTicket, verifyToken, type Ticket, type TicketClaims } from "./sign.ts";
export { GameStore, gameMigrations, storeFor, type GameStoreOptions, type MatchRecord, type Profile, type RatingMode, type RatingRow, type Result, type ResultSummary } from "./store.ts";
