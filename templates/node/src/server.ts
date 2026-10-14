import { serve } from "miujs/node";
import app from "./app.ts";

const server = await serve(app, { port: Number(process.env.PORT ?? 3000) });
console.log(`{{name}} listening on http://localhost:${server.port}`);
