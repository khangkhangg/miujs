import { definePlugin, miu, route, t } from "miujs";

const users = {
  getUser: route.get("/users/:id", {
    summary: "Get a user",
    params: t.object({ id: t.string() }),
    handler: ({ params }) => ({ id: params.id }),
  }),
  deleteUser: route.delete("/users/:id", {
    summary: "Delete a user",
    params: t.object({ id: t.string() }),
    handler: () => {},
  }),
  tests: {
    "returns the user": async (call: any) => {
      const res = await call(users.getUser, { params: { id: "7" } });
      res.expectStatus(200);
    },
  },
};

const fakeKv = definePlugin({ name: "fake-kv", cloudflare: () => ({ kv: ["CACHE"], d1: ["DB"], crons: ["0 * * * *"] }) });
const fakeRooms = definePlugin({ name: "fake-rooms", cloudflare: () => ({ durableObjects: [{ binding: "MIU_ROOMS", className: "MiuRooms" }], queues: { producers: ["JOBS"], consumers: ["JOBS"] } }) });

export default miu({ name: "basic-fixture", dev: true, logLevel: "silent", routes: [users], plugins: [fakeKv, fakeRooms] });
