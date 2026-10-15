/**
 * Tour Studio on Bun:  MIU_ENV=development bun apps/tour-studio/server.ts
 * Production:          MIU_ENV=production SESSION_SECRET=... ADMIN_PASSWORD=... DATA_DIR=/var/lib/tour-studio bun apps/tour-studio/server.ts
 */
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

const server = Bun.serve(studio.app.serveOptions({ port: config.port, hostname: config.host }));
console.log(`[tour-studio] listening on http://${config.host}:${server.port} (bun ${Bun.version}, ${config.dev ? "development" : "production"})`);

const shutdown = async () => {
  await server.stop();
  await studio.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
