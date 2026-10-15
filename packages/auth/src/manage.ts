// auth().manage(): users and sign-in for operators (@miujs/admin renders it, checks permissions
// and audits every change). Nothing here ever returns a password hash, token or provider secret.

import { errors, t, type Context, type ManageAction, type ManageList, type ManageSection, type ManageStat } from "miujs";
import { UNUSABLE_PASSWORD } from "./password.ts";
import type { StoredUser, UserStore } from "./store.ts";

export interface LoginLimits {
  perIpAccount: number;
  perAccount: number;
  perIp: number;
  windowSeconds: number;
}

/** What auth() lends its management section. */
export interface AuthManageDeps {
  users: UserStore;
  live: { allowSignUps: boolean; minPasswordLength: number };
  counters: { signUps: number; signIns: number; failedSignIns: number };
  loginLimits: LoginLimits;
  /** Whether a rate limiter is on (thresholds only matter then). */
  rateLimited: boolean;
  /** Whether POST /register is served. */
  register: boolean;
  passwordHashing: string;
  verification: string;
  oauthProviders: string[];
  passkeys: boolean;
  maxPasswordLength: number;
  /** True once a mailer is known (option or mail() plugin). */
  canMail(): boolean;
  /** Emails a password reset link to `user`. */
  sendReset(ctx: Context, user: StoredUser): Promise<void>;
}

const Id = { id: t.string({ minLength: 1, maxLength: 200 }) };

const noSuchUser = (id: string) => errors.notFound("User", id);

function storeLacks(users: UserStore, method: string) {
  return errors.config(
    "MIU_E_AUTH_STORE_UNSUPPORTED",
    `The ${users.kind} user store lacks ${method}, needed for this admin action`,
    "Use memoryUserStore() or dbUserStore(db), or implement that UserStore method in your store.",
  );
}

export function authManage(d: AuthManageDeps): ManageSection[] {
  const { users } = d;
  const need = <K extends keyof UserStore>(m: K): NonNullable<UserStore[K]> => {
    const fn = users[m];
    if (typeof fn !== "function") throw storeLacks(users, String(m));
    return (fn as (...a: unknown[]) => unknown).bind(users) as NonNullable<UserStore[K]>;
  };

  async function findUser(id: string, ctx: Context): Promise<StoredUser> {
    const u = await users.findUserById(id, ctx.env);
    if (!u) throw noSuchUser(id);
    return u;
  }

  const rowActions: ManageAction[] = [
    {
      name: "disable",
      title: "Disable user",
      description: "Signs the user out everywhere and blocks sign-in and API tokens until enabled again.",
      danger: true,
      input: t.object(Id),
      async run({ id }: { id: string }, ctx: Context) {
        const u = await findUser(id, ctx);
        if (u.disabledAt != null) return `${u.email} is already disabled`;
        await need("setUserDisabled")(id, Date.now(), ctx.env);
        await need("revokeSessions")(id, ctx.env);
        return `${u.email} is disabled and signed out everywhere`;
      },
    },
    {
      name: "enable",
      title: "Enable user",
      description: "Lets a disabled user sign in again; their API tokens work again.",
      input: t.object(Id),
      async run({ id }: { id: string }, ctx: Context) {
        const u = await findUser(id, ctx);
        if (u.disabledAt == null) return `${u.email} is already enabled`;
        await need("setUserDisabled")(id, null, ctx.env);
        return `${u.email} is enabled`;
      },
    },
    {
      name: "revokeSessions",
      title: "Sign out everywhere",
      description: "Ends every browser session of this user. API tokens keep working (revoke them separately).",
      danger: true,
      input: t.object(Id),
      async run({ id }: { id: string }, ctx: Context) {
        const v = await need("revokeSessions")(id, ctx.env);
        if (v === null) throw noSuchUser(id);
        const u = await users.findUserById(id, ctx.env);
        return `${u?.email ?? id} is signed out of every session`;
      },
    },
    {
      name: "revokeApiTokens",
      title: "Revoke API tokens",
      description: "Deletes every API token of this user.",
      danger: true,
      input: t.object(Id),
      async run({ id }: { id: string }, ctx: Context) {
        const u = await findUser(id, ctx);
        const n = await need("deleteUserTokens")(id, ctx.env);
        return `Revoked ${n} API token${n === 1 ? "" : "s"} of ${u.email}`;
      },
    },
  ];

  if (d.canMail()) {
    rowActions.push({
      name: "sendPasswordReset",
      title: "Send password reset email",
      description: "Emails the user a one-hour link to choose a new password. The link is never shown here.",
      input: t.object(Id),
      async run({ id }: { id: string }, ctx: Context) {
        const u = await findUser(id, ctx);
        if (u.disabledAt != null) throw errors.badRequest(`${u.email} is disabled`, "Enable the user first; a disabled user cannot sign in with a new password.");
        await d.sendReset(ctx, u);
        return `Password reset link sent to ${u.email}`;
      },
    });
  }

  if (d.oauthProviders.length) {
    rowActions.push({
      name: "unlinkOAuth",
      title: "Unlink a sign-in provider",
      description: "Removes the link to an OAuth/OpenID provider. Refused when it is the user's only way to sign in.",
      danger: true,
      input: t.object({ ...Id, provider: t.enum(d.oauthProviders as [string, ...string[]]) }),
      async run({ id, provider }: { id: string; provider: string }, ctx: Context) {
        const u = await findUser(id, ctx);
        const links = await need("listOAuthAccounts")(id, ctx.env);
        if (!links.some((a) => a.provider === provider)) return `${provider} is not linked to ${u.email}`;
        const hasPassword = !u.passwordHash.startsWith(UNUSABLE_PASSWORD);
        const passkeys = users.listPasskeys ? (await users.listPasskeys(id, ctx.env)).length : 0;
        if (!hasPassword && passkeys === 0 && links.length === 1) {
          throw errors.custom({
            code: "MIU_E_AUTH_OAUTH_LAST_METHOD",
            status: 409,
            message: `${provider} is the only way ${u.email} can sign in`,
            fix: d.canMail() ? "Send them a password reset email first (it lets them set a password), then unlink." : "Have the user add a passkey or link another provider first, then unlink.",
          });
        }
        await need("deleteOAuthAccount")(id, provider, ctx.env);
        return `Unlinked ${provider} from ${u.email}`;
      },
    });
  }

  const lists: ManageList[] = [];
  if (typeof users.listUsers === "function") {
    lists.push({
      name: "users",
      title: "Users",
      idKey: "id",
      searchable: true,
      columns: [
        { key: "email", label: "Email" },
        { key: "name", label: "Name" },
        { key: "roles", label: "Roles" },
        { key: "emailVerified", label: "Email verified", type: "boolean" },
        { key: "disabled", label: "Disabled", type: "boolean" },
        { key: "createdAt", label: "Created", type: "date" },
        { key: "id", label: "Id", type: "code" },
      ],
      async list(q, ctx) {
        const page = await users.listUsers!({ cursor: q.cursor, limit: q.limit, search: q.search?.trim() || undefined }, ctx.env);
        const rows = page.users.map((u) => ({
          id: u.id,
          email: u.email,
          name: u.name,
          roles: u.roles.join(", "),
          emailVerified: u.emailVerifiedAt != null,
          disabled: u.disabledAt != null,
          createdAt: u.createdAt,
        }));
        return page.next === undefined ? { rows } : { rows, next: page.next };
      },
      rowActions,
    });
  }

  const LimitInt = (max: number) => t.integer({ min: 1, max });
  const schema = t.object({
    allowSignUps: t.boolean({ description: "Let new accounts be created (password and OAuth). Existing users can always sign in." }),
    minPasswordLength: t.integer({ min: 1, max: d.maxPasswordLength, description: "Shortest password accepted for new passwords." }),
    loginPerIpAccount: LimitInt(1_000_000),
    loginPerAccount: LimitInt(1_000_000),
    loginPerIp: LimitInt(1_000_000),
    loginWindowSeconds: t.integer({ min: 1, max: 86_400 }),
  });

  const methods = ["password", ...d.oauthProviders, ...(d.passkeys ? ["passkeys"] : [])];

  return [
    {
      id: "accounts",
      title: "Accounts",
      description: "Users, sign-in methods and sign-in protection.",
      async status(ctx) {
        let total: number | null = null;
        if (typeof users.countUsers === "function") total = await users.countUsers(ctx.env);
        const since = "Since this instance started";
        const stats: ManageStat[] = [
          { label: "Users", value: total, ...(total === null ? { hint: `The ${users.kind} store cannot count users` } : {}) },
          { label: "Sign-ups", value: d.counters.signUps, hint: since },
          { label: "Sign-ins", value: d.counters.signIns, hint: since },
          { label: "Failed sign-ins", value: d.counters.failedSignIns, hint: since, ...(d.counters.failedSignIns > 0 && d.counters.failedSignIns >= d.counters.signIns ? { tone: "warning" as const } : {}) },
          { label: "Sign-in methods", value: methods.join(", "), ...(d.register ? {} : { hint: "no password sign-up route (register: false)" }) },
          { label: "Sign-ups open", value: d.live.allowSignUps, tone: d.live.allowSignUps ? "good" : "warning" },
          { label: "Password hashing", value: d.passwordHashing },
          { label: "Email verification", value: d.verification },
          { label: "Login rate limit", value: d.rateLimited ? `${d.loginLimits.perAccount} per account / ${d.loginLimits.windowSeconds}s` : "off", ...(d.rateLimited ? {} : { tone: "warning" as const }) },
        ];
        return { stats };
      },
      lists,
      settings: {
        schema,
        get() {
          return {
            allowSignUps: d.live.allowSignUps,
            minPasswordLength: d.live.minPasswordLength,
            loginPerIpAccount: d.loginLimits.perIpAccount,
            loginPerAccount: d.loginLimits.perAccount,
            loginPerIp: d.loginLimits.perIp,
            loginWindowSeconds: d.loginLimits.windowSeconds,
          };
        },
        set(v: { allowSignUps: boolean; minPasswordLength: number; loginPerIpAccount: number; loginPerAccount: number; loginPerIp: number; loginWindowSeconds: number }) {
          d.live.allowSignUps = v.allowSignUps;
          d.live.minPasswordLength = v.minPasswordLength;
          d.loginLimits.perIpAccount = v.loginPerIpAccount;
          d.loginLimits.perAccount = v.loginPerAccount;
          d.loginLimits.perIp = v.loginPerIp;
          d.loginLimits.windowSeconds = v.loginWindowSeconds;
        },
      },
    },
  ];
}
