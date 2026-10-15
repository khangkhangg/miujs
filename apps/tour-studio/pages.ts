/**
 * Server-rendered pages for Tour Studio: landing, sign up, log in, account. No scripts at all; one nonce'd
 * stylesheet; a strict CSP per response.
 */
import type { Context } from "../../src/index.ts";

export const esc = (s: unknown): string => String(s ?? "").replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function nonce(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replace(/[+/=]/g, "");
}

const CSS = `
:root{color-scheme:light dark;--bg:#fbfaf8;--fg:#1d1d1f;--muted:#6b6b70;--line:#e3e1dc;--accent:#2563eb;--card:#fff;--err:#c0262d}
@media (prefers-color-scheme:dark){:root{--bg:#121316;--fg:#ececee;--muted:#9a9aa2;--line:#2b2d33;--accent:#6ea0ff;--card:#1b1d22;--err:#ff6b6b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;border-bottom:1px solid var(--line)}
header a{color:inherit;text-decoration:none}.brand{font-weight:700}
nav{display:flex;gap:12px;align-items:center;flex-wrap:wrap}nav a{color:var(--accent)}
nav form{margin:0}nav button{background:none;border:0;color:var(--accent);font:inherit;cursor:pointer;padding:0}
main{max-width:56rem;margin:0 auto;padding:24px 16px}
h1{font-size:28px;margin:0 0 16px}
.tours{display:grid;grid-template-columns:repeat(auto-fill,minmax(15rem,1fr));gap:16px;padding:0;list-style:none}
.tour{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px}
.tour a{font-weight:600;color:var(--accent)}.tour p{margin:6px 0 0;color:var(--muted)}
form.auth{max-width:22rem;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:20px}
label{display:block;margin:0 0 12px;font-size:14px;color:var(--muted)}
input{display:block;width:100%;margin-top:4px;padding:8px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit}
button.primary{padding:8px 14px;border:0;border-radius:6px;background:var(--accent);color:#fff;font:inherit;cursor:pointer}
.error{color:var(--err)}.muted{color:var(--muted)}
code{word-break:break-all}
`;

export interface Viewer {
  name: string;
  roles: string[];
}

export function page(c: Context<any, any>, o: { title: string; body: string; user?: Viewer; status?: number }): Response {
  const n = nonce();
  const u = o.user;
  const nav = u
    ? `<a href="/editor">My tours</a><a href="/account">Account</a>${u.roles.includes("admin") ? `<a href="/admin">Admin</a>` : ""}
<form method="post" action="/logout"><button type="submit">Log out</button></form>`
    : `<a href="/login">Log in</a><a href="/signup">Sign up</a>`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,"><title>${esc(o.title)}</title><style nonce="${n}">${CSS}</style></head>
<body><header><a class="brand" href="/">Tour Studio</a><nav>${nav}</nav></header>
<main>${o.body}</main></body></html>`;
  return c.html(html, o.status ?? 200, {
    "content-security-policy": `default-src 'none'; style-src 'nonce-${n}'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    "cache-control": "no-store",
  });
}

export function landing(tours: { title: string; slug: string; description?: string }[]): string {
  const items = tours.length
    ? tours.map((t) => `<li class="tour"><a href="/t/${esc(t.slug)}">${esc(t.title)}</a>${t.description ? `<p>${esc(t.description)}</p>` : ""}</li>`).join("")
    : `<li class="muted">No published tours yet.</li>`;
  return `<h1>Published tours</h1><ul class="tours" id="published-tours">${items}</ul>
<p class="muted">Creators: <a href="/signup">sign up</a> to build your own 360° tour. Agents: <a href="/llms.txt">/llms.txt</a>, MCP at <code>/mcp</code>.</p>`;
}

export function loginForm(next: string, error?: string): string {
  return `<h1>Log in</h1>${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
<form class="auth" method="post" action="/login?next=${encodeURIComponent(next)}">
<label>Email <input name="email" type="email" autocomplete="username" required></label>
<label>Password <input name="password" type="password" autocomplete="current-password" required></label>
<button class="primary" type="submit">Log in</button></form>
<p class="muted">No account? <a href="/signup">Sign up</a></p>`;
}

export function signupForm(error?: string, values: { email?: string; name?: string } = {}): string {
  return `<h1>Create your account</h1>${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
<form class="auth" method="post" action="/signup">
<label>Name <input name="name" autocomplete="name" required maxlength="80" value="${esc(values.name)}"></label>
<label>Email <input name="email" type="email" autocomplete="username" required value="${esc(values.email)}"></label>
<label>Password <input name="password" type="password" autocomplete="new-password" required minlength="8"></label>
<button class="primary" type="submit">Sign up</button></form>`;
}

export function accountPage(user: { email: string; name: string }, created?: { key: string; name?: string }): string {
  return `<h1>Account</h1><p>${esc(user.name)} &lt;${esc(user.email)}&gt;</p>
<h2>API keys for agents</h2>
<p class="muted">An API key lets an AI agent build tours for you over MCP (<code>POST /mcp</code> with <code>Authorization: Bearer &lt;key&gt;</code>).</p>
${created ? `<p>New key${created.name ? ` “${esc(created.name)}”` : ""} — copy it now, it is shown only once:</p><p><code id="api-key">${esc(created.key)}</code></p>` : ""}
<form class="auth" method="post" action="/account/keys">
<label>Key name <input name="name" maxlength="80" placeholder="e.g. Claude"></label>
<button class="primary" type="submit">Create API key</button></form>`;
}
