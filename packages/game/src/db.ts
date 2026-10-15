// The database the game kit uses when you do not pass one: D1 binding "DB" on Workers, one
// shared in-memory SQLite database elsewhere (so profiles, matches and leaderboards can join).

import { d1, sqlite, type DatabaseSource } from "@miujs/db";
import { targetRuntime } from "miujs";

let local: DatabaseSource | null = null;

export function defaultDatabase(): DatabaseSource {
  if (targetRuntime() === "workerd") return d1("DB");
  return (local ??= sqlite(":memory:"));
}

export function isD1Ref(source: DatabaseSource): source is Extract<DatabaseSource, { binding: string }> {
  return typeof (source as { binding?: unknown }).binding === "string" && typeof (source as { prepare?: unknown }).prepare !== "function";
}
