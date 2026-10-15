/**
 * Tour Studio on Node 22+:  MIU_ENV=development node --experimental-strip-types apps/tour-studio/server-node.ts
 * Same app, same data directory layout as the Bun server (node:sqlite instead of bun:sqlite).
 */
import { serve } from "../../src/adapters/node.ts";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { seed } from "./seed.ts";

const config = loadConfig();
const studio = await createApp(config);
if (config.seed) {
  await seed(studio.data, {
    adminEmail: config.adminEmail,
    adminPassword: config.adminPassword,
    panoramaWidth: config.seedPanoramaWidth,
    log: console.log,
  });
  if (config.dev && !process.env.ADMIN_PASSWORD) console.log(`[seed] dev admin password: ${config.adminPassword}`);
}

const server = await serve(studio.app, { port: config.port, hostname: config.host });
console.log(`[tour-studio] listening on http://${config.host}:${server.port} (node ${process.version}, ${config.dev ? "development" : "production"})`);

const shutdown = async () => {
  await server.close();
  await studio.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
