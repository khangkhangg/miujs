// Player profile routes over the game store.
//
//   GET   /players/me        (auth)  your profile, created from the signed-in user on first call
//   PATCH /players/me        (auth)  { displayName?, avatarKey? }  avatarKey is a file key (e.g. from @miujs/files)
//   GET   /players/:id               public profile + unlocked achievements (MCP tool `player_profile`)

import { definePlugin, errors, route, t, type CloudflareNeeds, type Env } from "miujs";
import type { DatabaseSource } from "@miujs/db";
import { systemClock, type Clock } from "@miujs/realtime";
import type { AchievementSet } from "./achievements.ts";
import { defaultDatabase, isD1Ref } from "./db.ts";
import { storeFor, type GameStore } from "./store.ts";

export interface ProfilesOptions {
  database?: DatabaseSource;
  achievements?: AchievementSet;
  path?: string;
  clock?: Clock;
}

export function profiles(opts: ProfilesOptions = {}) {
  const prefix = (opts.path ?? "/players").replace(/\/+$/, "");
  const source = opts.database ?? defaultDatabase();
  const clock = opts.clock ?? systemClock;
  const store = (env: Env): GameStore => storeFor(source, env, { clock, achievements: opts.achievements });

  async function view(s: GameStore, id: string) {
    const profile = await s.profile(id);
    if (!profile) throw errors.notFound("player", id);
    const defs = opts.achievements?.defs ?? {};
    const achievements = (await s.unlocked(id)).map((u) => ({ id: u.id, title: defs[u.id]?.title ?? u.id, at: u.at }));
    return { profile, achievements };
  }

  const routes = [
    route.get(`${prefix}/me`, {
      name: "player_me",
      summary: "Your player profile (ratings per queue, games, achievements)",
      tags: ["game"],
      auth: "required",
      mcp: false,
      handler: async ({ user, env }) => {
        const s = store(env);
        await s.ensurePlayer(user.id, typeof user.name === "string" && user.name ? user.name : user.id);
        return view(s, user.id);
      },
    }),
    route.patch(`${prefix}/me`, {
      name: "player_update",
      summary: "Change your display name or avatar file key",
      tags: ["game"],
      auth: "required",
      mcp: false,
      body: t.object({
        displayName: t.optional(t.string({ minLength: 1, maxLength: 32 })),
        avatarKey: t.optional(t.nullable(t.string({ maxLength: 256, pattern: /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9/_.-]*$/ }))),
      }),
      handler: async ({ user, body, env }) => {
        const s = store(env);
        await s.ensurePlayer(user.id, typeof user.name === "string" && user.name ? user.name : user.id);
        await s.updateProfile(user.id, body);
        return view(s, user.id);
      },
    }),
    route.get(`${prefix}/:id`, {
      name: "player_profile",
      summary: "A player's public profile: display name, ratings per queue, games won and achievements",
      tags: ["game"],
      params: t.object({ id: t.string({ maxLength: 128 }) }),
      handler: ({ params, env }) => view(store(env), params.id),
    }),
  ];

  return definePlugin({
    name: "profiles",
    routes,
    inspect: () => ({ path: prefix, achievements: opts.achievements?.ids ?? [] }),
    cloudflare: (): CloudflareNeeds => (isD1Ref(source) ? { d1: [source.binding] } : {}),
  });
}
