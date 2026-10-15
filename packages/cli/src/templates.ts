// File templates for `miu add` and `miu new`. Every scaffold ships a failing test so the
// first thing an agent (or person) sees is what to make pass.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function camel(name: string): string {
  return name.replace(/[-_ ]+([a-zA-Z0-9])/g, (_m, c: string) => c.toUpperCase()).replace(/^[A-Z]/, (c) => c.toLowerCase());
}

export function routeTemplate(urlPath: string, exportName: string, file: string): string {
  return `import { errors, route, t, type CallFn } from "miujs";

export const ${exportName} = route.get("${urlPath}", {
  summary: "TODO: one line saying what this route does",
  response: t.object({ ok: t.boolean() }),
  handler: async () => {
    // TODO: implement, then make the test below pass.
    throw errors.custom({
      code: "MIU_E_NOT_IMPLEMENTED",
      status: 501,
      message: "${exportName} is not implemented yet",
      fix: "Write the handler in ${file}.",
    });
  },
});

export const tests = {
  "${exportName} returns 200": async (call: CallFn) => {
    (await call(${exportName})).expectStatus(200);
  },
};
`;
}

export function jobTemplate(name: string, exportName: string): string {
  return `import { t } from "miujs";
import { defineJob } from "@miujs/queue";

export const ${exportName} = defineJob("${name}", {
  input: t.object({ id: t.string() }),
  retries: 3,
  run: async ({ input, log }) => {
    // TODO: do the work. Throwing retries the job with backoff.
    log.info("${name} ran", { id: input.id });
  },
});
`;
}

export function roomTemplate(name: string, exportName: string): string {
  return `import { t } from "miujs";
import { defineRoom } from "@miujs/realtime";

export const ${exportName} = defineRoom("${name}", {
  state: t.object({ messages: t.array(t.object({ from: t.string(), text: t.string() })) }),
  client: { say: t.object({ text: t.string({ minLength: 1, maxLength: 500 }) }) },
  init: () => ({ messages: [] }),
  on: {
    say: ({ room, sender, msg }) => {
      room.state.messages.push({ from: sender.name, text: msg.text });
    },
  },
});
`;
}

export function pluginTemplate(name: string, exportName: string): string {
  return `import { definePlugin } from "miujs";

export const ${exportName} = (opts: { enabled?: boolean } = {}) =>
  definePlugin({
    name: "${name}",
    onRequest(ctx) {
      if (opts.enabled === false) return;
      // TODO: runs after route matching, before validation. Return a Response to stop the request.
      ctx.log.debug("${name} saw request", { route: ctx.route?.name });
    },
  });
`;
}

export function newProjectFiles(name: string): Record<string, string> {
  return {
    "package.json": JSON.stringify(
      {
        name,
        private: true,
        type: "module",
        scripts: { dev: "miu dev", start: "bun app.ts", test: "miu test", inspect: "miu inspect" },
        dependencies: { miujs: "^0.1.0" },
        devDependencies: { "@miujs/cli": "^0.1.0", "@types/bun": "latest", typescript: "latest" },
      },
      null,
      2,
    ) + "\n",
    "tsconfig.json": JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          types: ["bun"],
          strict: true,
          noEmit: true,
          allowImportingTsExtensions: true,
          verbatimModuleSyntax: true,
          erasableSyntaxOnly: true,
          skipLibCheck: true,
        },
      },
      null,
      2,
    ) + "\n",
    ".gitignore": "node_modules/\n.wrangler/\n.env\n*.sqlite\n",
    "app.ts": `import { miu } from "miujs";
import * as health from "./routes/health.ts";

const app = miu({
  name: "${name}",
  routes: [health],
  mcp: true, // every route is also an MCP tool at /mcp
});

export default app; // \`bun app.ts\`, \`deno serve app.ts\` or Cloudflare Workers
`,
    "routes/health.ts": `import { route, t, type CallFn } from "miujs";

export const health = route.get("/health", {
  summary: "Check that the app is up",
  response: t.object({ ok: t.boolean() }),
  handler: () => ({ ok: true }),
});

export const tests = {
  "health returns ok": async (call: CallFn) => {
    const res = await call(health);
    res.expectStatus(200);
  },
};
`,
    "AGENTS.md": `# AGENTS.md

This is a MiuJS app. Conventions:

- One route per file in \`routes/\`, with its schema, handler and \`tests\` export together.
- Add a route: \`miu add route <path>\` (creates the file and a failing test), then register it in \`app.ts\`.
- Run \`miu test\` after every change; \`miu inspect --json\` lists routes, schemas and plugins.
- Throw \`errors.*\` from "miujs" (stable MIU_E_* codes with a fix), never plain strings.
- TypeScript must be erasable (no enums/namespaces); import local files with \`.ts\`.
`,
  };
}

// ---------------------------------------------------------------------------------------------
// `miu new --template <name>`: the files live in packages/cli/templates/<name>/ (real files, so
// they are easy to read and edit), with __APP_NAME__ replaced. Common files are generated here.

export interface TemplateInfo {
  description: string;
  dependencies: string[];
  /** Extra lines for the generated AGENTS.md. */
  notes: string[];
  jsx?: boolean;
  /** Printed by `miu new`: the full kit is still being built elsewhere. */
  inProgress?: boolean;
}

export const TEMPLATES: Record<string, TemplateInfo> = {
  api: { description: "JSON API with a health route", dependencies: ["miujs"], notes: [] },
  fullstack: {
    description: "@miujs/web JSX pages + htmx",
    dependencies: ["miujs", "@miujs/web"],
    jsx: true,
    notes: [
      "Pages are JSX (`.tsx`, `@miujs/web` runtime) rendered on the server; `render(<Page />)` returns the Response.",
      "Interactivity is htmx: routes return HTML fragments for `hx-*` requests (`renderPage` picks fragment vs full page).",
    ],
  },
  "quiz-game": {
    description: "Kahoot-style quiz on realtime rooms (copy of examples/quiz)",
    dependencies: ["miujs", "@miujs/realtime"],
    notes: ["The game is a room in `room.ts` (state, messages, timers); `public/index.html` is a dependency-free client.", "On Cloudflare the room runs in the `MiuRooms` Durable Object exported from app.ts."],
  },
  chat: {
    description: "Realtime chat room + client page",
    dependencies: ["miujs", "@miujs/realtime"],
    notes: ["The chat room is `rooms/chat.ts`; `public/index.html` speaks the rooms wire protocol over a WebSocket.", "On Cloudflare the room runs in the `MiuRooms` Durable Object exported from app.ts."],
  },
  "saas-starter": {
    description: "Auth, sessions, orgs (access), mail, audit log and workflows, wired together",
    dependencies: ["miujs", "@miujs/db", "@miujs/session", "@miujs/auth", "@miujs/access", "@miujs/mail", "@miujs/audit", "@miujs/workflows"],
    notes: [
      "Plugin order matters: db → session → auth → access → mail → audit → workflows (see app.ts).",
      "Tenant data is always filtered by `tenantScope(ctx)` (the verified org id), never by an id from the request body.",
      "Secrets: SESSION_SECRET and AUDIT_HMAC_KEY (32+ random chars each); RESEND_API_KEY for mail in production.",
    ],
  },
  crm: {
    description: "Contacts per org with a follow-up workflow (minimal starter; full kit in progress)",
    dependencies: ["miujs", "@miujs/db", "@miujs/session", "@miujs/auth", "@miujs/access", "@miujs/workflows"],
    inProgress: true,
    notes: ["Contacts are tenant data: every query filters by `tenantScope(ctx)`.", "Creating a contact emits `contact.created`, which starts the `contact-follow-up` workflow."],
  },
  game: {
    description: "A realtime multiplayer room (minimal starter; full kit in progress)",
    dependencies: ["miujs", "@miujs/realtime"],
    inProgress: true,
    notes: ["The game is a room in `rooms/tictactoe.ts`: state, typed client messages and server-side rules.", "On Cloudflare the room runs in the `MiuRooms` Durable Object exported from app.ts."],
  },
};

const TEMPLATE_ROOT = new URL("../templates/", import.meta.url);

function readTree(dir: URL, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  const path = fileURLToPath(dir);
  for (const name of readdirSync(path)) {
    const full = `${path}/${name}`;
    if (statSync(full).isDirectory()) Object.assign(out, readTree(new URL(`${name}/`, dir), `${prefix}${name}/`));
    else out[`${prefix}${name}`] = readFileSync(full, "utf8");
  }
  return out;
}

/** Every file of a new project made from `template`. */
export function templateFiles(template: string, name: string): Record<string, string> {
  const info = TEMPLATES[template];
  const base = newProjectFiles(name);
  if (template === "api") return base;
  const files: Record<string, string> = {};
  for (const [rel, text] of Object.entries(readTree(new URL(`${template}/`, TEMPLATE_ROOT)))) files[rel] = text.replaceAll("__APP_NAME__", name);
  const pkg = JSON.parse(base["package.json"]);
  pkg.dependencies = Object.fromEntries(info.dependencies.map((d) => [d, "^0.1.0"]));
  pkg.scripts.check = "miu check";
  const tsconfig = JSON.parse(base["tsconfig.json"]);
  if (info.jsx) Object.assign(tsconfig.compilerOptions, { jsx: "react-jsx", jsxImportSource: "@miujs/web" });
  const agents = base["AGENTS.md"] + (info.notes.length ? `\nThis app (template \`${template}\`):\n\n${info.notes.map((n) => `- ${n}`).join("\n")}\n` : "");
  return {
    ...files,
    "package.json": JSON.stringify(pkg, null, 2) + "\n",
    "tsconfig.json": JSON.stringify(tsconfig, null, 2) + "\n",
    ".gitignore": base[".gitignore"],
    "AGENTS.md": agents,
  };
}
