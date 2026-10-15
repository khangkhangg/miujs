import { createApp } from "./app.ts";

const app = await createApp();
const server = app.listen(Number(process.env.PORT ?? 3000));
console.log(`{{name}} on http://localhost:${server.port}/admin  (MCP: POST /mcp, OpenAPI: /openapi.json)`);
