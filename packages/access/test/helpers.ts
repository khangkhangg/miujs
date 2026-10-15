import { definePlugin, type AuthUser } from "miujs";

/** Test-only sign-in: `x-user: <id>` picks a user from the table. Stands in for @miujs/auth. */
export function testAuth(users: Record<string, { email?: string; roles: string[]; emailVerified?: boolean }>) {
  return definePlugin({
    name: "test-auth",
    onRequest(ctx) {
      const id = ctx.headers.get("x-user");
      const u = id && Object.prototype.hasOwnProperty.call(users, id) ? users[id] : undefined;
      if (id && u) ctx.user = { id, ...u } as AuthUser;
    },
  });
}

export const USERS: Record<string, { email?: string; roles: string[]; emailVerified?: boolean }> = {
  alice: { email: "alice@example.com", roles: [] },
  bob: { email: "bob@example.com", roles: [] },
  carol: { email: "Carol@Example.com", roles: [] },
  dave: { email: "dave@example.com", roles: [] },
  root: { email: "root@example.com", roles: ["owner"] },
};
