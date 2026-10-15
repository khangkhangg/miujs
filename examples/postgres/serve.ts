// Runs the app on Bun / Node with a pooled connection: DATABASE_URL=postgres://... bun serve.ts
// Ctrl+C stops the server and closes the pool (app.stop()), so the process exits cleanly.
import app from "./app.ts";

const server = await app.listen(Number(process.env.PORT ?? 3000));
console.log(`${app.name} listening on ${server.url}`);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void server.stop().then(() => process.exit(0)));
}
