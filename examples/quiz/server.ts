// bun examples/quiz/server.ts  ->  open http://localhost:3000 (one tab as host, others as players)
// On Node: node --experimental-strip-types examples/quiz/node.ts
import { app } from "./app.ts";

const server = app.listen(Number(process.env.PORT ?? 3000));
console.log(`Quiz running on http://localhost:${server.port}`);
