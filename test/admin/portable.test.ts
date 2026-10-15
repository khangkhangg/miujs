import { expect, test } from "bun:test";

// The admin and the SQL repository core must stay Web-standard (Workers-safe): no bun:/node: imports anywhere
// in their module graphs. (The SQLite driver itself lives behind miujs/sqlite.)
for (const entry of ["src/admin/index.ts", "src/batteries/data/sql.ts", "src/adapters/cloudflare/d1-repository.ts"]) {
  test(`${entry} is portable`, async () => {
    const seen = new Set<string>();
    const walk = async (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = await Bun.file(file).text();
      expect({ file, native: /from\s+"(node:|bun:|bun")/.test(src) }).toEqual({ file, native: false });
      for (const m of src.matchAll(/^(?:import|export)(?!\s+type)[^;]*?from\s+"(\.[^"]+)"/gm)) {
        await walk(new URL(m[1]!, `file://${file}`).pathname);
      }
    };
    await walk(new URL(`../../${entry}`, import.meta.url).pathname);
    expect([...seen].some((f) => /\/(batteries\/sqlite|data\/sqlite)\.ts$/.test(f))).toBe(false);
  });
}
