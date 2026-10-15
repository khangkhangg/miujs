// Cloudflare Workers entry bundled by scripts/release/verify.ts from the installed tarballs with
// Wrangler's resolve conditions (workerd, worker, browser). The bundle must have no static node:*
// or bun:* imports; runtime-guarded dynamic imports are allowed and listed.
import { miu, route, t } from "miujs";
import * as access from "@miujs/access";
import * as aiPkg from "@miujs/ai";
import * as audit from "@miujs/audit";
import { auth, dbUserStore } from "@miujs/auth";
import { bots } from "@miujs/bots";
import { cache } from "@miujs/cache";
import { d1, db } from "@miujs/db";
import { files, r2Store } from "@miujs/files";
import * as mailPkg from "@miujs/mail";
import { defineJob, queue } from "@miujs/queue";
import * as ratelimit from "@miujs/ratelimit";
import { defineRoom, rooms } from "@miujs/realtime";
import { session } from "@miujs/session";
import { html, render } from "@miujs/web";
import * as workflows from "@miujs/workflows";

const ping = defineJob("ping", { input: t.object({ n: t.number() }), run: async () => {} });
const chat = defineRoom("chat", {
  state: t.object({ n: t.number() }),
  client: {},
  init: () => ({ n: 0 }),
  on: {},
});

// Namespace imports keep whole packages in the bundle, so their imports are checked too.
const bundled = { access, aiPkg, audit, mailPkg, ratelimit, workflows };

const app = miu({
  name: "release-verify-worker",
  routes: [
    route.get("/health", { handler: ({ runtime }) => ({ ok: true, runtime, packages: Object.keys(bundled).length }) }),
    route.get("/page", { handler: () => render(html`<h1>hi</h1>`) }),
  ],
  plugins: [session(), db({ database: d1("DB") }), auth({ users: dbUserStore(d1("DB")) }), cache(), queue({ jobs: [ping] }), rooms({ rooms: [chat] }), bots(), files({ store: r2Store("FILES") })],
});

export default app;
