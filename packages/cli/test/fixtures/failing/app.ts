import { miu, route } from "miujs";

const mod = {
  hello: route.get("/hello", { handler: () => "hi" }),
  tests: {
    "passes": async (call: any) => (await call(mod.hello)).expectStatus(200),
    "fails on purpose": async (call: any) => (await call(mod.hello)).expectStatus(201),
  },
};

// A leaked key the `check` command must flag.
export const leaked = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export default miu({ name: "failing-fixture", logLevel: "silent", routes: [mod] });
