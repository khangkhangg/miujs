// File templates for `miu add` and `miu new`. Every scaffold ships a failing test so the
// first thing an agent (or person) sees is what to make pass.

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
