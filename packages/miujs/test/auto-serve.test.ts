import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { miu } from "../src/index.ts";

// `bun app.ts` serves the default export only if Bun recognizes it as a server config. Bun 1.4
// skips a default export that has a `stop` member (it looks like a running Server), so App must
// never expose one; shutdown is `app.close()`.
test("App exposes no `stop` member, which would stop Bun from serving the default export", () => {
  const app = miu({});
  expect("stop" in app).toBe(false);
  expect(typeof app.close).toBe("function");
});

test("`bun app.ts` with `export default miu(...)` serves requests", async () => {
  const dir = mkdtempSync(join(import.meta.dir, ".tmp-serve-"));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const file = join(dir, "app.ts");
  writeFileSync(
    file,
    `import { miu, route } from "../../src/index.ts";\n` +
      `export default miu({ routes: [route.get("/", { handler: () => "served" })] });\n`,
  );
  const proc = Bun.spawn([process.execPath, file], { env: { ...process.env, PORT: String(port) }, stdout: "ignore", stderr: "pipe" });
  try {
    let body = "";
    for (let i = 0; i < 50 && !body; i++) {
      await Bun.sleep(100);
      if (proc.exitCode !== null) break;
      body = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text(), () => "");
    }
    expect(proc.exitCode).toBeNull(); // still running: it is serving, not exiting
    expect(body).toBe("served");
  } finally {
    proc.kill();
    await proc.exited;
    rmSync(dir, { recursive: true, force: true });
  }
});
