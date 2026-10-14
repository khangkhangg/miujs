// node --experimental-strip-types examples/quiz/node.ts  ->  open http://localhost:3000
// Same app and WebSocket handlers as the Bun version (server.ts).
import { serve } from "../../src/adapters/node.ts";
import { app } from "./app.ts";

const server = await serve(app, { port: Number(process.env.PORT ?? 3000) });
console.log(`Quiz running on http://localhost:${server.port} (Node ${process.version})`);
