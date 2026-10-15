// Achievements: named checks over a player's stats. The store evaluates them whenever stats
// change, stores each unlock once (INSERT OR IGNORE) and emits `achievement.unlocked`.
//
//   export const achievements = defineAchievements({
//     firstWin: { title: "First win", check: (s) => s.wins >= 1 },
//     veteran:  { title: "Veteran", description: "Play 100 games", check: (s) => s.games >= 100 },
//   });
//   achievements.on("achievement.unlocked", ({ playerId, id, title }) => ...);

import { gameErrors } from "./errors.ts";

/** Stats every player has, plus any custom counters from `store.addStats()`. */
export interface PlayerStats {
  games: number;
  wins: number;
  losses: number;
  draws: number;
  [key: string]: number;
}

export interface AchievementDef {
  title: string;
  description?: string;
  /** Hidden until unlocked (shown as "???" in listings). */
  hidden?: boolean;
  check(stats: PlayerStats): boolean;
}

export interface Unlock {
  playerId: string;
  id: string;
  title: string;
  at: number;
}

export type AchievementEvent = "achievement.unlocked";

export class AchievementSet {
  readonly defs: Readonly<Record<string, AchievementDef>>;
  private listeners = new Set<(u: Unlock) => void>();

  constructor(defs: Record<string, AchievementDef>) {
    for (const [id, d] of Object.entries(defs)) {
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(id) || !d || typeof d.check !== "function" || typeof d.title !== "string") {
        throw gameErrors.achievementInvalid(id);
      }
    }
    this.defs = { ...defs };
  }

  get ids(): string[] {
    return Object.keys(this.defs);
  }

  /** Ids whose check passes for these stats (a check that throws counts as not passed). */
  evaluate(stats: PlayerStats): string[] {
    return this.ids.filter((id) => {
      try {
        return this.defs[id].check(stats) === true;
      } catch {
        return false;
      }
    });
  }

  /** Listen for unlocks. Returns an unsubscribe function. */
  on(_event: AchievementEvent, fn: (u: Unlock) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** @internal called by the store once per new unlock. */
  emit(u: Unlock): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(u);
      } catch (err) {
        console.error("[miujs/game] achievement.unlocked listener failed:", err);
      }
    }
  }
}

/** Define achievements, evaluated on every stat update. */
export function defineAchievements(defs: Record<string, AchievementDef>): AchievementSet {
  return new AchievementSet(defs);
}
