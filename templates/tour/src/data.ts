import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { hashPassword } from "miujs";
import { openDatabase, sqliteRepository, sqliteStore } from "miujs/sqlite";
import { diskBlobStore } from "miujs/node";
import type { Hotspot, Scene, Tour } from "miujs/tour";

/**
 * Storage for the app: one SQLite file for users, tours, scenes, hotspots, sessions and rate limits, and a
 * directory for panorama images. To scale out, swap these for shared drivers with the same interfaces
 * (e.g. `d1Repository`/`r2BlobStore`/`d1Store` from "miujs/cloudflare", or `redisStore` for sessions).
 */
export interface User { id: string; email: string; name: string; roles: string[]; passwordHash: string }

export async function openData(dataDir: string) {
  mkdirSync(dataDir, { recursive: true });
  const db = await openDatabase(join(dataDir, "app.sqlite"));
  return {
    db,
    store: sqliteStore({ db }),
    files: diskBlobStore({ root: join(dataDir, "uploads") }),
    users: sqliteRepository<User>({ db, table: "users", indexes: ["email"], searchFields: ["email", "name"] }),
    tours: sqliteRepository<Tour>({ db, table: "tours", indexes: ["ownerId", "slug", "status"], searchFields: ["title", "slug", "description"] }),
    scenes: sqliteRepository<Scene>({ db, table: "scenes", indexes: ["tourId"], searchFields: ["title"] }),
    hotspots: sqliteRepository<Hotspot>({ db, table: "hotspots", indexes: ["tourId"] }),
  };
}

export type Data = Awaited<ReturnType<typeof openData>>;

export const findUser = async (data: Data, email: string) =>
  (await data.users.list({ where: { email: email.trim().toLowerCase() }, limit: 1 })).items[0];

export async function createUser(data: Data, u: { email: string; name: string; password: string; roles?: string[] }): Promise<User> {
  return data.users.create({
    email: u.email.trim().toLowerCase(),
    name: u.name.trim(),
    roles: u.roles ?? ["creator"],
    passwordHash: await hashPassword(u.password),
  } as Omit<User, "id">);
}

export const randomToken = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
