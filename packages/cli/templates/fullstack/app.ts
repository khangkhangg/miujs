// __APP_NAME__: server-rendered JSX pages (@miujs/web) made interactive with htmx.
//
//   bun app.ts        → http://localhost:3000
//   miu test          → runs the `tests` exported by routes/*.tsx
//
// htmx.org is loaded from unpkg in components/Layout.tsx; pages are plain HTML responses.

import { miu } from "miujs";
import * as home from "./routes/home.tsx";

const app = miu({
  name: "__APP_NAME__",
  routes: [home],
  mcp: true, // JSON routes are MCP tools at /mcp; pages opt out with `mcp: false`
});

export default app; // `bun app.ts`, `deno serve app.ts` or Cloudflare Workers
