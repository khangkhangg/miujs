// @miujs/game/client: browser-safe helpers (no server imports).
//
//   import { findMatch, connectMatch, snapshotInterpolation, predictor } from "@miujs/game/client";

export { connectMatch, findMatch, type FindMatchOptions, type MatchedStatus, type SeatInfo } from "./connect.ts";
export { lerpState, predictor, snapshotInterpolation, type Interpolator, type Predictor } from "./interp.ts";
