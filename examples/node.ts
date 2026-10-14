// node --experimental-strip-types examples/node.ts
import { serve } from "../src/adapters/node.ts";
import app from "./basic.ts";

const server = await serve(app, { port: Number(process.env.PORT ?? 3000) });
console.log(`miu (node) listening on http://localhost:${server.port}`);
