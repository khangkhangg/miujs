import type { Tour } from "miujs/tour";

/** Server-rendered pages: the landing page and the sign-up / log-in forms. No client-side script. */

export interface Viewer { name: string; isAdmin: boolean }

export const PAGE_CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

const STYLE = `*{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,sans-serif;color:#1d1d1f;background:#f5f5f7}
header{display:flex;gap:1rem;align-items:center;padding:1rem clamp(1rem,4vw,3rem);background:#fff;border-bottom:1px solid #e5e5ea}
header .brand{font-weight:700;margin-right:auto;color:inherit;text-decoration:none}header form{margin:0}
a{color:#0b63ce}button{font:inherit;cursor:pointer;padding:.45rem 1rem;border-radius:8px;border:1px solid #0b63ce;background:#0b63ce;color:#fff}
header button{background:none;color:#0b63ce;border:none;padding:0}
main{max-width:1100px;margin:0 auto;padding:2rem clamp(1rem,4vw,3rem)}
.grid{display:grid;gap:1.25rem;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));padding:0;list-style:none}
.card{background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px #0001}.card a{color:inherit;text-decoration:none;display:block}
.card img,.card .ph{width:100%;aspect-ratio:2/1;object-fit:cover;display:block;background:#d8dbe2}.card div{padding:.75rem 1rem}
.card h2{font-size:1.05rem;margin:0}.card p{margin:.25rem 0 0;color:#6e6e73;font-size:.9rem}
.box{max-width:360px;margin:3rem auto;background:#fff;padding:2rem;border-radius:12px;box-shadow:0 1px 4px #0001}
label{display:block;margin:.8rem 0}input{width:100%;padding:.5rem;margin-top:.25rem;border:1px solid #c7c7cc;border-radius:6px;font:inherit}
.error{color:#b00020}`;

function layout(title: string, viewer: Viewer | undefined, body: string): string {
  const nav = viewer
    ? `<a href="/editor">My tours</a>${viewer.isAdmin ? `<a href="/admin">Admin</a>` : ""}<form method="post" action="/logout"><button>Log out (${esc(viewer.name)})</button></form>`
    : `<a href="/login">Log in</a><a href="/signup">Sign up</a>`;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>${STYLE}</style>
<header><a class="brand" href="/">{{name}}</a>${nav}</header><main>${body}</main></html>`;
}

/** Published tours with a cover image (the cover or the start scene's panorama). */
export function landingPage(items: { tour: Tour; coverUrl?: string }[], viewer: Viewer | undefined): string {
  const cards = items.map(({ tour, coverUrl }) => `<li class="card"><a href="/t/${encodeURIComponent(tour.slug)}">
${coverUrl ? `<img src="${esc(coverUrl)}" alt="" loading="lazy">` : `<span class="ph"></span>`}
<div><h2>${esc(tour.title)}</h2>${tour.description ? `<p>${esc(tour.description)}</p>` : ""}</div></a></li>`);
  const empty = `<p>No published tours yet. ${viewer ? `<a href="/editor">Create one</a>` : `<a href="/signup">Sign up</a> to create one`}, or run <code>bun run seed</code> for a sample.</p>`;
  return layout("Virtual tours", viewer, `<h1>Virtual tours</h1>${cards.length ? `<ul class="grid">${cards.join("")}</ul>` : empty}`);
}

export function authPage(kind: "login" | "signup", opts: { next: string; error?: string }): string {
  const signup = kind === "signup";
  const action = `/${kind}?next=${encodeURIComponent(opts.next)}`;
  const other = signup
    ? `Already have an account? <a href="/login?next=${encodeURIComponent(opts.next)}">Log in</a>`
    : `New here? <a href="/signup?next=${encodeURIComponent(opts.next)}">Create an account</a>`;
  return layout(signup ? "Sign up" : "Log in", undefined, `<form class="box" method="post" action="${esc(action)}">
<h1>${signup ? "Create your account" : "Log in"}</h1>${opts.error ? `<p class="error" role="alert">${esc(opts.error)}</p>` : ""}
${signup ? `<label>Name <input name="name" required maxlength="80" autocomplete="name"></label>` : ""}
<label>Email <input name="email" type="email" required autocomplete="username"></label>
<label>Password <input name="password" type="password" required ${signup ? `minlength="8" autocomplete="new-password"` : `autocomplete="current-password"`}></label>
<button>${signup ? "Sign up" : "Log in"}</button><p>${other}</p></form>`);
}
