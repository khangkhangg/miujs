import { expect, test } from "bun:test";

test("framework bindings, loadtest and msgpack are subpath exports", async () => {
  expect(typeof (await import("@miujs/realtime/react")).useRoom).toBe("function");
  expect(typeof (await import("@miujs/realtime/vue")).useRoom).toBe("function");
  expect(typeof (await import("@miujs/realtime/svelte")).roomStore).toBe("function");
  expect(typeof (await import("@miujs/realtime/loadtest")).loadtest).toBe("function");
  expect(typeof (await import("@miujs/realtime/msgpack")).encode).toBe("function");
});

test("browser-side modules never import the server core", async () => {
  for (const f of ["client", "store", "react", "vue", "svelte", "msgpack", "diff"]) {
    const src = await Bun.file(new URL(`../src/${f}.ts`, import.meta.url)).text();
    expect(src).not.toMatch(/from "miujs"/);
  }
});
