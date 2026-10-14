import { expect, test } from "bun:test";

test("src/devtools never imports node:/bun: modules (safe for the root entry and Workers)", async () => {
  const seen = new Set<string>();
  const walk = async (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = await Bun.file(file).text();
    expect({ file, native: /from\s+"(node:|bun:|bun")/.test(src) }).toEqual({ file, native: false });
    for (const m of src.matchAll(/^(?:import|export)[^;]*?from\s+"(\.[^"]+)"/gm)) await walk(new URL(m[1]!, `file://${file}`).pathname);
  };
  await walk(new URL("../../src/devtools/index.ts", import.meta.url).pathname);
  expect(seen.size).toBeGreaterThan(5);
});

test("devtools bundle builds for the browser target", async () => {
  const out = await Bun.build({ entrypoints: [new URL("../../src/devtools/index.ts", import.meta.url).pathname], target: "browser" });
  expect(out.success).toBe(true);
});
