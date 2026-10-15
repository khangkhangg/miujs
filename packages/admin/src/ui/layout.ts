// The page shell: header with brand and org switcher, resource navigation, main region.

import type { Context } from "miujs";
import { html, render, type HtmlString } from "@miujs/web";
import type { ResourceMeta } from "../meta.ts";
import { orgOf, PAGE_HEADERS } from "./http.ts";

export interface Shell {
  path: string;
  title: string;
  brand?: { name?: string; logo?: string };
  css: string;
  js: string;
}

export interface PageInput {
  title: string;
  /** Nav key: a resource name, "workflows" or "home". */
  active?: string;
  body: HtmlString;
  status?: number;
  resources: ResourceMeta[];
  orgs: { id: string; name: string }[];
  workflows: boolean;
  /** Extra response headers (e.g. Set-Cookie). */
  headers?: HeadersInit;
}

function nonceAttr(ctx: Context): HtmlString | string {
  const n = ctx.state.cspNonce;
  return typeof n === "string" ? html` nonce="${n}"` : "";
}

function orgSwitcher(shell: Shell, ctx: Context, orgs: { id: string; name: string }[]): HtmlString | string {
  if (!orgs.length) return "";
  const current = orgOf(ctx);
  const next = ctx.url.pathname + ctx.url.search;
  return html`<form method="post" action="${shell.path}/org" class="org-switch"><label for="org-switch" class="sr-only">Organization</label><select id="org-switch" name="orgId" data-autosubmit>${orgs.map(
    (o) => html`<option value="${o.id}"${o.id === current ? html` selected` : ""}>${o.name}</option>`,
  )}</select><input type="hidden" name="next" value="${next}"><button type="submit">Switch</button></form>`;
}

export function page(shell: Shell, ctx: Context, p: PageInput): Response {
  const link = (href: string, key: string, label: string) => html`<li><a href="${href}"${p.active === key ? html` aria-current="page"` : ""}>${label}</a></li>`;
  const brandName = shell.brand?.name ?? shell.title;
  const logo = shell.brand?.logo ? html`<img src="${shell.brand.logo}" alt="">` : "";
  const user = ctx.user as { id: string; email?: string; name?: string } | undefined;
  const doc = html`<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${p.title === shell.title ? shell.title : `${p.title} · ${shell.title}`}</title><link rel="stylesheet" href="${shell.path}/assets/${shell.css}"><script src="${shell.path}/assets/${shell.js}" defer${nonceAttr(ctx)}></script></head>
<body data-org="${orgOf(ctx) ?? ""}"><a class="skip" href="#main">Skip to content</a>
<header class="top"><a class="brand" href="${shell.path}">${logo}<span>${brandName}</span></a><div class="top-actions">${orgSwitcher(shell, ctx, p.orgs)}${
    user ? html`<span class="muted hide-sm">${user.email ?? user.name ?? user.id}</span><form method="post" action="${shell.path}/logout"><button type="submit">Sign out</button></form>` : ""
  }</div></header>
<div class="shell"><nav class="side" aria-label="Admin"><ul>${link(shell.path, "home", "Overview")}</ul><h2>Records</h2><ul>${p.resources.map((r) => link(`${shell.path}/r/${r.name}`, r.name, r.label))}</ul>${
    p.workflows ? html`<h2>Automation</h2><ul>${link(`${shell.path}/workflows`, "workflows", "Workflows")}</ul>` : ""
  }</nav>
<main id="main" tabindex="-1">${p.body}</main></div>
<div class="sr-only" aria-live="polite" data-live></div>
</body></html>`;
  const headers = new Headers(PAGE_HEADERS);
  if (p.headers) new Headers(p.headers).forEach((v, k) => headers.append(k, v));
  return render(doc, { status: p.status ?? 200, headers });
}

/** A minimal page for signed-out screens (no nav). */
export function barePage(shell: Shell, ctx: Context, title: string, body: HtmlString, status = 200): Response {
  const doc = html`<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · ${shell.title}</title><link rel="stylesheet" href="${shell.path}/assets/${shell.css}"></head><body><main id="main" class="login">${body}</main></body></html>`;
  return render(doc, { status, headers: PAGE_HEADERS });
}

export function alert(messages: string[] | string, kind: "error" | "ok" = "error"): HtmlString {
  const list = Array.isArray(messages) ? messages : [messages];
  if (!list.length) return html``;
  return kind === "ok"
    ? html`<div class="alert ok" role="status">${list.length === 1 ? list[0] : html`<ul>${list.map((m) => html`<li>${m}</li>`)}</ul>`}</div>`
    : html`<div class="alert" role="alert">${list.length === 1 ? list[0] : html`<ul>${list.map((m) => html`<li>${m}</li>`)}</ul>`}</div>`;
}
