// Org, member and invitation routes.

import { errors, route, t, type Context } from "miujs";
import { roleCovers, type OrgInfo } from "./permissions.ts";
import { notMember, storeFor, type AccessOptions } from "./plugin.ts";

export interface RouteState {
  /** Copied from `app.dev` in setup. */
  dev: boolean;
}

const DAY = 86_400_000;

function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** Hex SHA-256, as stored for invite tokens. */
export async function sha256Hex(s: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
}

/** 32 random bytes, base64url (43 chars). */
export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
const oneLine = (s: string) => s.replace(/[\r\n\t]+/g, " ").trim();

const hasRole = (opts: AccessOptions, role: string) => Object.prototype.hasOwnProperty.call(opts.roles, role);

export function unknownRole(opts: AccessOptions, role: string) {
  return errors.custom({
    code: "MIU_E_ACCESS_ROLE_UNKNOWN",
    status: 400,
    message: `Unknown role ${JSON.stringify(role)}`,
    fix: `Use one of: ${Object.keys(opts.roles).join(", ")}.`,
  });
}

function roleTooHigh(mine: string, target: string) {
  return errors.custom({
    code: "MIU_E_ACCESS_ROLE_TOO_HIGH",
    status: 403,
    message: `Your role (${mine}) cannot grant or change the role "${target}"`,
    fix: `Only someone whose role includes every permission of "${target}" can do this. Ask an owner.`,
  });
}

export const lastOwner = (ownerRole: string) =>
  errors.custom({
    code: "MIU_E_ACCESS_LAST_OWNER",
    status: 409,
    message: `This is the organization's last ${ownerRole}`,
    fix: `Make another member ${ownerRole} first (PATCH /orgs/:orgId/members/:userId with { "role": "${ownerRole}" }), then try again.`,
  });

/** The org from the path, verified by the plugin's onRequest. */
function activeOrg(ctx: Context, orgId: string): OrgInfo {
  const org = ctx.org;
  if (!org || org.id !== orgId) throw notMember();
  return org;
}

const OrgOut = t.object({ id: t.string(), name: t.string(), role: t.string() });
const MemberOut = t.object({ userId: t.string(), email: t.nullable(t.string()), role: t.string(), createdAt: t.number() });
const OrgParams = t.object({ orgId: t.string({ minLength: 1, maxLength: 128 }) });
const MemberParams = t.object({ orgId: t.string({ minLength: 1, maxLength: 128 }), userId: t.string({ minLength: 1, maxLength: 200 }) });

export function accessRoutes(opts: AccessOptions, state: RouteState) {
  const base = (opts.basePath ?? "").replace(/\/+$/, "");
  const ownerRole = opts.ownerRole ?? "owner";
  const ttlDays = opts.inviteTtlDays ?? 7;
  const tags = ["access"];

  function inviteLink(ctx: Context, token: string): string {
    if (opts.inviteUrl) return opts.inviteUrl(token, ctx);
    let appUrl = opts.appUrl ?? (typeof ctx.env?.APP_URL === "string" ? (ctx.env.APP_URL as string) : undefined);
    if (!appUrl) {
      // The Host header is client-controlled: only trust it in dev.
      if (!state.dev) {
        throw errors.config(
          "MIU_E_ACCESS_APP_URL_MISSING",
          "No public URL for invite links",
          "Set APP_URL in the environment, or pass access({ appUrl }) or access({ inviteUrl: (token) => ... }).",
        );
      }
      appUrl = ctx.url.origin;
    }
    return `${appUrl.replace(/\/+$/, "")}/invites/${token}`;
  }

  const createOrg = route.post(`${base}/orgs`, {
    name: "access_create_org",
    summary: "Create an organization; you become its owner",
    tags,
    auth: "required",
    status: 201,
    body: t.object({ name: t.string({ minLength: 1, maxLength: 200 }) }),
    response: t.object({ org: OrgOut }),
    handler: async (ctx) => {
      const name = ctx.body.name.trim();
      if (!name) throw errors.badRequest("Organization name is empty", "Send a non-blank name.");
      const org = await storeFor(opts, ctx as unknown as Context).createOrg({ name, ownerId: ctx.user.id, ownerEmail: ctx.user.email ?? null, ownerRole });
      return { org: { id: org.id, name: org.name, role: ownerRole } };
    },
  });

  const listOrgs = route.get(`${base}/orgs`, {
    name: "access_list_orgs",
    summary: "List the organizations you belong to, with your role in each",
    tags,
    auth: "required",
    response: t.object({ orgs: t.array(t.object({ id: t.string(), name: t.string(), role: t.string(), createdAt: t.number() })) }),
    handler: async (ctx) => {
      const orgs = await storeFor(opts, ctx as unknown as Context).listOrgs(ctx.user.id);
      return { orgs: orgs.map((o) => ({ id: o.id, name: o.name, role: o.role, createdAt: o.createdAt })) };
    },
  });

  const listMembers = route.get(`${base}/orgs/:orgId/members`, {
    name: "access_list_members",
    summary: "List an organization's members and their roles (needs members:read)",
    tags,
    auth: "required",
    params: OrgParams,
    response: t.object({ members: t.array(MemberOut) }),
    handler: async (ctx) => {
      activeOrg(ctx as unknown as Context, ctx.params.orgId);
      ctx.authorize("members:read");
      return { members: await storeFor(opts, ctx as unknown as Context).listMembers(ctx.params.orgId) };
    },
  });

  const createInvite = route.post(`${base}/orgs/:orgId/invites`, {
    name: "access_create_invite",
    summary: `Invite someone by email to join an organization with a role (needs members:invite; link expires in ${ttlDays} days)`,
    tags,
    auth: "required",
    status: 201,
    params: OrgParams,
    body: t.object({ email: t.string({ format: "email", maxLength: 254 }), role: t.string({ minLength: 1, maxLength: 64 }) }),
    response: t.object({
      invite: t.object({ id: t.string(), email: t.string(), role: t.string(), expiresAt: t.number() }),
      inviteUrl: t.optional(t.string()),
    }),
    handler: async (ctx) => {
      const c = ctx as unknown as Context;
      const org = activeOrg(c, ctx.params.orgId);
      ctx.authorize("members:invite");
      const role = ctx.body.role;
      if (!hasRole(opts, role)) throw unknownRole(opts, role);
      if (!roleCovers(opts.roles, org.role, role)) throw roleTooHigh(org.role, role);
      const email = ctx.body.email.trim().toLowerCase();
      const store = storeFor(opts, c);
      const existing = await store.database.prepare("SELECT 1 AS x FROM access_memberships WHERE org_id = ? AND email = ?").bind(org.id, email).first("x");
      if (existing) {
        throw errors.custom({ code: "MIU_E_ACCESS_ALREADY_MEMBER", status: 409, message: `${email} is already a member`, fix: "Change their role with PATCH /orgs/:orgId/members/:userId instead." });
      }
      if (!opts.mailer && !state.dev) {
        throw errors.config("MIU_E_ACCESS_MAILER_MISSING", "No mailer configured to send invitations", "Pass access({ mailer }) with a send({ to, subject, html, text }) method (e.g. from @miujs/mail).");
      }
      const token = randomToken();
      const url = inviteLink(c, token);
      const now = Date.now();
      const invite = { id: crypto.randomUUID(), orgId: org.id, email, role, tokenHash: await sha256Hex(token), invitedBy: ctx.user.id, createdAt: now, expiresAt: now + ttlDays * DAY, acceptedAt: null, acceptedBy: null };
      await store.revokePendingInvites(org.id, email);
      await store.createInvite(invite);
      const out = { invite: { id: invite.id, email, role, expiresAt: invite.expiresAt } };
      if (!opts.mailer) return { ...out, inviteUrl: url };
      const orgName = oneLine((await store.getOrg(org.id))?.name ?? "an organization");
      try {
        await opts.mailer.send({
          to: email,
          subject: `You're invited to join ${orgName}`,
          text: `You have been invited to join ${orgName} as ${role}.\n\nAccept the invitation: ${url}\n\nThe link expires in ${ttlDays} days. If you did not expect this, ignore this email.`,
          html: `<p>You have been invited to join <strong>${escapeHtml(orgName)}</strong> as ${escapeHtml(role)}.</p><p><a href="${escapeHtml(url)}">Accept the invitation</a></p><p>The link expires in ${ttlDays} days. If you did not expect this, ignore this email.</p>`,
        });
      } catch (err) {
        await store.revokePendingInvites(org.id, email);
        throw err;
      }
      return out;
    },
  });

  const acceptInvite = route.post(`${base}/invites/:token/accept`, {
    name: "access_accept_invite",
    summary: "Accept an invitation (signed in as the invited email)",
    tags,
    auth: "required",
    mcp: false,
    params: t.object({ token: t.string({ minLength: 1, maxLength: 200 }) }),
    response: t.object({ org: OrgOut }),
    handler: async (ctx) => {
      // @miujs/auth sets emailVerified only when email verification is on. An unconfirmed address
      // could belong to someone else, so it must not unlock an invite sent to that address.
      if (ctx.user.emailVerified === false) {
        throw errors.custom({
          code: "MIU_E_ACCESS_EMAIL_UNVERIFIED",
          status: 403,
          message: "Confirm your email address before accepting an invitation",
          fix: "Open the link in the confirmation email (or request a new one with POST /auth/verify-email/request), then accept the invitation again.",
        });
      }
      const store = storeFor(opts, ctx as unknown as Context);
      const invalid = () => errors.custom({ code: "MIU_E_ACCESS_INVITE_INVALID", status: 404, message: "Invitation not found", fix: "Check the link, or ask for a new invitation." });
      const invite = await store.findInviteByHash(await sha256Hex(ctx.params.token));
      if (!invite) throw invalid();
      if (!opts.allowAnyEmail) {
        const mine = typeof ctx.user.email === "string" ? ctx.user.email.trim().toLowerCase() : null;
        if (mine !== invite.email) {
          throw errors.custom({
            code: "MIU_E_ACCESS_INVITE_EMAIL_MISMATCH",
            status: 403,
            message: "This invitation was sent to a different email address",
            fix: "Sign in with the account for the invited email, or ask for an invitation to your email.",
          });
        }
      }
      const used = () => errors.custom({ code: "MIU_E_ACCESS_INVITE_USED", status: 410, message: "This invitation has already been used", fix: "Ask for a new invitation." });
      const now = Date.now();
      if (invite.acceptedAt !== null) throw used();
      if (invite.expiresAt <= now) {
        throw errors.custom({ code: "MIU_E_ACCESS_INVITE_EXPIRED", status: 410, message: "This invitation has expired", fix: "Ask an organization owner to send a new invitation." });
      }
      if (!(await store.consumeInvite(invite.id, ctx.user.id, now))) throw used();
      await store.addMember(invite.orgId, ctx.user.id, invite.role, ctx.user.email ?? null);
      const membership = await store.getMembership(invite.orgId, ctx.user.id);
      const org = await store.getOrg(invite.orgId);
      if (!membership || !org) throw invalid();
      return { org: { id: org.id, name: org.name, role: membership.role } };
    },
  });

  const updateMember = route.patch(`${base}/orgs/:orgId/members/:userId`, {
    name: "access_update_member",
    summary: "Change a member's role (needs members:manage; the last owner cannot be demoted)",
    tags,
    auth: "required",
    params: MemberParams,
    body: t.object({ role: t.string({ minLength: 1, maxLength: 64 }) }),
    response: t.object({ member: t.object({ userId: t.string(), role: t.string() }) }),
    handler: async (ctx) => {
      const c = ctx as unknown as Context;
      const org = activeOrg(c, ctx.params.orgId);
      ctx.authorize("members:manage");
      const role = ctx.body.role;
      if (!hasRole(opts, role)) throw unknownRole(opts, role);
      const store = storeFor(opts, c);
      const target = await store.getMembership(org.id, ctx.params.userId);
      if (!target) throw errors.notFound("Member", ctx.params.userId);
      if (!roleCovers(opts.roles, org.role, target.role)) throw roleTooHigh(org.role, target.role);
      if (!roleCovers(opts.roles, org.role, role)) throw roleTooHigh(org.role, role);
      const r = await store.setRole(org.id, ctx.params.userId, role, ownerRole);
      if (r === "not_found") throw errors.notFound("Member", ctx.params.userId);
      if (r === "last_owner") throw lastOwner(ownerRole);
      return { member: { userId: ctx.params.userId, role } };
    },
  });

  const removeMember = route.delete(`${base}/orgs/:orgId/members/:userId`, {
    name: "access_remove_member",
    summary: "Remove a member, or leave yourself (needs members:manage to remove others; the last owner cannot leave)",
    tags,
    auth: "required",
    params: MemberParams,
    handler: async (ctx) => {
      const c = ctx as unknown as Context;
      const org = activeOrg(c, ctx.params.orgId);
      const store = storeFor(opts, c);
      const self = ctx.params.userId === ctx.user.id;
      if (!self) {
        ctx.authorize("members:manage");
        const target = await store.getMembership(org.id, ctx.params.userId);
        if (!target) throw errors.notFound("Member", ctx.params.userId);
        if (!roleCovers(opts.roles, org.role, target.role)) throw roleTooHigh(org.role, target.role);
      }
      const r = await store.removeMember(org.id, ctx.params.userId, ownerRole);
      if (r === "not_found") throw errors.notFound("Member", ctx.params.userId);
      if (r === "last_owner") throw lastOwner(ownerRole);
    },
  });

  return [createOrg, listOrgs, listMembers, createInvite, acceptInvite, updateMember, removeMember];
}
