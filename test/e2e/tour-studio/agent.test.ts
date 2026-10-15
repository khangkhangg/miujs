/**
 * Journey 4 — an AI agent: a creator mints an API key, then the agent builds and publishes a whole tour over
 * MCP (createMcpClient from miujs/client) with nothing but that key. Real server (Bun, production mode).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createMcpClient, type McpClient, type McpToolResult } from "../../../src/client/index.ts";
import { Client, creator, panorama, panorama2, squarePng, startServer, toBase64, type Server } from "./helpers.ts";

let server: Server;
let base = "";
beforeAll(async () => {
  server = await startServer();
  base = server.url;
}, 60_000);
afterAll(() => server?.stop());

const json = (r: McpToolResult) => (r.structuredContent ?? JSON.parse(r.content[0]!.text ?? "null")) as Record<string, any>;

describe("agent journey (MCP + API key)", () => {
  let agent: McpClient;
  let ownerId = "";
  let tourId = "";
  let slug = "";
  const sceneIds: string[] = [];

  test("a creator creates an API key; the agent initializes and lists tools", async () => {
    const c = await creator(base, "Agent Owner");
    ownerId = c.id;
    const res = await c.client.json("POST", "/api/keys", { name: "claude" });
    expect(res.status).toBe(201);
    const { key } = (await res.json()) as { key: string };

    agent = createMcpClient(`${base}/mcp`, { headers: { authorization: `Bearer ${key}` } });
    const init = await agent.initialize();
    expect(init.serverInfo.name).toBe("tour-studio");
    expect(init.instructions).toContain("scene_import");

    const tools = await agent.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ["tour_create", "tour_get", "tour_list", "scene_import", "hotspot_create", "tour_publish", "public_tour_get", "whoami", "published_tours"]) {
      expect(names).toContain(n);
    }
    // browser-only routes are not tools
    expect(names).not.toContain("scene_upload");
    expect(names.some((n) => n.includes("login") || n.includes("signup") || n.includes("keys"))).toBe(false);
    const importTool = tools.find((t) => t.name === "scene_import")!;
    expect(importTool.inputSchema.required).toEqual(expect.arrayContaining(["id", "title", "panoramaBase64"]));
    expect(tools.find((t) => t.name === "tour_get")!.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "tour_delete")!.annotations?.destructiveHint).toBe(true);

    const me = await agent.callTool("whoami");
    expect(json(me)).toMatchObject({ id: ownerId, name: "Agent Owner" });
  });

  test("create a tour", async () => {
    const r = await agent.callTool("tour_create", { title: "Mountain Cabin", description: "Built by an agent" });
    expect(r.isError).toBe(false);
    const t = json(r);
    expect(t.ownerId).toBe(ownerId);
    tourId = t.id;
    slug = t.slug;
  });

  test("import scenes as base64 (and as a data: URL); a bad image is a readable tool error", async () => {
    const a = await agent.callTool("scene_import", { id: tourId, title: "Porch", panoramaBase64: toBase64(await panorama()), initialView: { yaw: 10, pitch: 0, fov: 70 } });
    expect(a.isError).toBe(false);
    sceneIds.push(json(a).id);
    expect(json(a)).toMatchObject({ width: 1024, height: 512, initialView: { yaw: 10, pitch: 0, fov: 70 } });
    const b = await agent.callTool("scene_import", { id: tourId, title: "Living room", panoramaBase64: `data:image/png;base64,${toBase64(await panorama2())}` });
    expect(b.isError).toBe(false);
    sceneIds.push(json(b).id);

    const bad = await agent.callTool("scene_import", { id: tourId, title: "Square", panoramaBase64: toBase64(await squarePng()) });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toContain("equirectangular");
    const junk = await agent.callTool("scene_import", { id: tourId, title: "Junk", panoramaBase64: toBase64(new TextEncoder().encode("not an image")) });
    expect(junk.isError).toBe(true);
    expect(junk.content[0]!.text).toContain("415");
  });

  test("link the scenes with hotspots, add an info point, publish", async () => {
    const [porch, living] = sceneIds as [string, string];
    // Publishing too early (no links needed, but a dangling link is a problem) shows the problems list.
    const dangling = json(await agent.callTool("hotspot_create", { id: porch, kind: "link", yaw: 30, pitch: -5, title: "Door" }));
    const early = await agent.callTool("tour_publish", { id: tourId });
    expect(early.isError).toBe(true);
    expect(early.content[0]!.text).toContain("link_missing_target");
    expect((await agent.callTool("hotspot_update", { id: dangling.id, targetSceneId: living })).isError).toBe(false);

    const back = await agent.callTool("hotspot_create", { id: living, kind: "link", yaw: -150, pitch: -5, targetSceneId: porch, title: "Back to the porch" });
    expect(back.isError).toBe(false);
    const info = await agent.callTool("hotspot_create", { id: living, kind: "info", yaw: 0, pitch: 15, title: "Fireplace", text: "Original stone" });
    expect(info.isError).toBe(false);

    const pub = await agent.callTool("tour_publish", { id: tourId });
    expect(pub.isError).toBe(false);
    expect(json(pub).status).toBe("published");

    const full = json(await agent.callTool("tour_get", { id: tourId }));
    expect(full.scenes).toHaveLength(2);
    expect(full.hotspots).toHaveLength(3);
    expect(full.tour.startSceneId).toBe(porch);
  });

  test("the tour renders publicly", async () => {
    const v = new Client(base);
    const page = await v.get(`/t/${slug}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<h1>Mountain Cabin</h1>");
    const bundle = (await (await v.get(`/api/public/tours/${slug}`)).json()) as { scenes: { panoramaUrl: string }[] };
    expect(bundle.scenes).toHaveLength(2);
    const media = await v.get(bundle.scenes[1]!.panoramaUrl);
    expect(media.status).toBe(200);
    expect(media.headers.get("content-type")).toBe("image/png");
    expect(await (await v.get("/")).text()).toContain("Mountain Cabin");
    // ...and the public tool works without credentials
    const anon = createMcpClient(`${base}/mcp`);
    const pub = await anon.callTool("public_tour_get", { slug });
    expect(pub.isError).toBe(false);
    expect(json(pub).tour.title).toBe("Mountain Cabin");
  });

  test("without a key the agent cannot create anything; with someone else's tour it gets 403", async () => {
    const anon = createMcpClient(`${base}/mcp`);
    const r = await anon.callTool("tour_create", { title: "x" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("401");

    const other = await creator(base, "Other");
    const k = (await (await other.client.json("POST", "/api/keys", {})).json()) as { key: string };
    const otherAgent = createMcpClient(`${base}/mcp`, { headers: { authorization: `Bearer ${k.key}` } });
    const steal = await otherAgent.callTool("tour_unpublish", { id: tourId });
    expect(steal.isError).toBe(true);
    expect(steal.content[0]!.text).toContain("not_owner");
  });
});
