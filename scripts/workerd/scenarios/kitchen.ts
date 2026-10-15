// The harness fixture (scripts/workerd/apps/kitchen) on workerd: R2 files and signed URLs, Queues
// produce → consume with retries, a cron trigger, the Rate Limiting binding, the Durable Object
// rate limiter, @miujs/bots with the Cache API store, KV sessions and Cloudflare Workflows.

import { Client, check, eq, explorer, scenario, sleep, waitFor, type AppSpec, type Dev } from "../lib.ts";
import type { SuiteContext } from "../run.ts";

export const app: AppSpec = {
  name: "kitchen",
  dir: "scripts/workerd/apps/kitchen",
  entry: "app.ts",
  vars: { FILES_SECRET: "workerd-harness-files-secret-0123456789abcdef", SESSION_SECRET: "workerd-harness-session-secret-0123456789abcdef" },
};

const BROWSER = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  "accept-language": "en-US,en;q=0.9",
  accept: "text/html,application/json",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-dest": "document",
  "sec-ch-ua": '"Chromium";v="141", "Not?A_Brand";v="8"',
};
const GPTBOT = { "user-agent": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)" };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);

export async function run(dev: Dev, _ctx: SuiteContext) {
  const S = (name: string, fn: () => Promise<string | void>) => scenario("kitchen", name, fn);
  const c = new Client(dev.url, BROWSER);
  const mark = async (key: string) => (await c.get(`/marks/${encodeURIComponent(key)}`)).json?.value;

  // ---- R2 ----------------------------------------------------------------------------------
  await S("R2: put, get, list and delete through ctx.files (r2Store)", async () => {
    const put = await c.req("PUT", "/files/hello.txt", { body: "xin chào R2", headers: { "content-type": "text/plain" } });
    check(put.status === 200, `put ${put.status}: ${put.text.slice(0, 300)}`);
    eq((await c.get("/files/hello.txt")).text, "xin chào R2", "get");
    check((await c.get("/files")).json.keys.includes("docs/hello.txt"), "list");
    const buckets = await explorer(dev, "/r2/buckets");
    const bucket = JSON.stringify(buckets).match(/kitchen-files|FILES/)?.[0];
    check(bucket, `R2 bucket not visible in the explorer: ${JSON.stringify(buckets).slice(0, 300)}`);
    await c.req("PUT", "/files/gone.txt", { body: "x" });
    eq((await c.req("DELETE", "/files/gone.txt")).status, 204, "delete");
    eq((await c.get("/files/gone.txt")).status, 404, "deleted");
    return `bucket ${bucket}, put ${put.json.size} bytes`;
  });

  await S("R2: signed GET URL downloads; a tampered token is 403", async () => {
    const { url } = (await c.get("/files/hello.txt/link")).json;
    check(typeof url === "string" && url.includes("/_files/"), `url ${url}`);
    const got = await fetch(url);
    eq([got.status, await got.text()], [200, "xin chào R2"], "signed download");
    const bad = url.slice(0, -3) + (url.endsWith("AAA") ? "BBB" : "AAA");
    eq((await fetch(bad)).status, 403, "tampered token");
    return new URL(url).pathname.slice(0, 40) + "…";
  });

  await S("R2: signed PUT URL uploads (size and type enforced)", async () => {
    const { url } = (await c.get("/files/up.txt/link?method=PUT")).json;
    const put = await fetch(url, { method: "PUT", body: "uploaded via signed url", headers: { "content-type": "text/plain" } });
    check(put.status < 300, `signed PUT ${put.status}: ${(await put.text()).slice(0, 200)}`);
    eq((await c.get("/files/up.txt")).text, "uploaded via signed url", "read back");
    const big = await fetch((await c.get("/files/big.txt/link?method=PUT")).json.url, { method: "PUT", body: "x".repeat(4096), headers: { "content-type": "text/plain" } });
    check(big.status === 413 || big.status === 400, `oversized signed PUT ${big.status}`);
  });

  await S("R2: handleUpload checks real bytes (PNG accepted, text named .png refused)", async () => {
    const fd = new FormData();
    fd.append("file", new Blob([PNG], { type: "image/png" }), "dot.png");
    const ok = await c.req("POST", "/upload", { body: fd });
    check(ok.status === 200 && ok.json.files[0].type === "image/png", `upload ${ok.status}: ${ok.text.slice(0, 300)}`);
    const fake = new FormData();
    fake.append("file", new Blob(["not a png"], { type: "image/png" }), "fake.png");
    const bad = await c.req("POST", "/upload", { body: fake });
    check(bad.status >= 400 && bad.status < 500, `fake png ${bad.status}`);
    return `stored ${ok.json.files[0].key}; fake refused with ${bad.json?.error?.code}`;
  });

  // ---- Queues --------------------------------------------------------------------------------
  await S("Queues: a dispatched job runs in the consumer and writes to KV", async () => {
    const t0 = performance.now();
    eq((await c.post("/jobs/a")).status, 200, "dispatch");
    const v = await waitFor(() => mark("mark:a"), 15_000, "the job's KV mark", 100);
    eq(v.via, "route", "via");
    return `ran ${Math.round(performance.now() - t0)} ms after dispatch (attempt ${v.attempt})`;
  });

  await S("Queues: a failing job is retried with backoff (msg.retry) and then succeeds", async () => {
    const t0 = performance.now();
    await c.post("/jobs/f?flaky=true");
    const v = await waitFor(() => mark("mark:f"), 30_000, "the retried job's KV mark", 200);
    eq(v.attempt, 2, "succeeded on attempt");
    return `attempt 2 after ${Math.round(performance.now() - t0)} ms`;
  });

  await S("Cron trigger: /__scheduled runs the schedule, which dispatches its job", async () => {
    const r = await fetch(`${dev.url}/__scheduled?cron=${encodeURIComponent("*/5 * * * *")}`);
    check(r.status === 200, `__scheduled ${r.status}`);
    const v = await waitFor(() => mark("mark:cron"), 15_000, "the cron job's KV mark", 100);
    eq(v.via, "cron", "via");
  });

  // ---- rate limits ---------------------------------------------------------------------------
  await S("Rate Limiting binding: 5 per 10 s per IP, then 429 with Retry-After", async () => {
    const statuses: number[] = [];
    let retryAfter: string | null = null;
    for (let i = 0; i < 8; i++) {
      const r = await c.get("/limited");
      statuses.push(r.status);
      if (r.status === 429) retryAfter = r.headers.get("retry-after");
    }
    check(statuses.slice(0, 5).every((s) => s === 200), `first five: ${statuses}`);
    check(statuses.includes(429), `no 429 from the binding: ${statuses} (Miniflare simulates [[ratelimits]] locally)`);
    return `statuses ${statuses.join(",")}, retry-after ${retryAfter}`;
  });

  await S("Durable Object rate limiter: exact count (3 per minute), RateLimit headers", async () => {
    const res = [];
    for (let i = 0; i < 4; i++) res.push(await c.get("/limited-do"));
    eq(
      res.map((r) => r.status),
      [200, 200, 200, 429],
      "statuses",
    );
    const h = res[1].headers;
    check(h.get("ratelimit-remaining") === "1" || h.get("ratelimit")?.includes("r=1"), `headers: ${[...h].filter(([k]) => k.startsWith("ratelimit")).join(" | ")}`);
  });

  // ---- bots ----------------------------------------------------------------------------------
  await S("bots: GPTBot gets a cached copy from the Cache API store (miss, then hit)", async () => {
    const ai = new Client(dev.url, GPTBOT);
    const first = await ai.get("/posts/1");
    eq([first.status, first.headers.get("x-miu-bot-cache"), first.json.servedTo], [200, "miss", "ai"], "first");
    const second = await waitFor(
      async () => {
        const r = await ai.get("/posts/1?utm_source=feed");
        return r.headers.get("x-miu-bot-cache") === "hit" ? r : null;
      },
      5000,
      "a cache hit",
      100,
    );
    eq(second.json.renderedAt, first.json.renderedAt, "same rendered copy");
  });

  await S("bots: browser headers → human; curl / python-requests → bot (User-Agent paths)", async () => {
    eq((await c.get("/visitor")).json.visitor.kind, "human", "browser");
    eq((await new Client(dev.url, { "user-agent": "curl/8.9.1" }).get("/visitor")).json.visitor.kind, "bot", "curl");
    eq((await new Client(dev.url, { "user-agent": "python-requests/2.32.3" }).get("/visitor")).json.visitor.kind, "bot", "python-requests");
    const g = await new Client(dev.url, { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" }).get("/visitor");
    eq(g.json.visitor.kind, "bot", "unverified Googlebot claim");
  });

  await S("bots: request.cf signals (Miniflare placeholder cf, and MF-CF-Blob overrides)", async () => {
    const r = await c.get("/visitor");
    const cf = r.json.cf ?? {};
    const placeholder = JSON.stringify({ score: cf.botManagement?.score, verifiedBot: cf.botManagement?.verifiedBot, country: cf.country, asn: cf.asn });
    // A unique query per call: bot visitors otherwise get the bot cache's copy of /visitor.
    let n = 0;
    const as = async (ua: Record<string, string>, blob: unknown) => (await new Client(dev.url, ua).get(`/visitor?n=${++n}`, { headers: { "MF-CF-Blob": JSON.stringify(blob) } })).json;
    const bare = { "user-agent": BROWSER["user-agent"] };
    // Low bot score: a browser UA is still a bot.
    const low = await as(BROWSER, { country: "VN", asn: 7552, botManagement: { score: 2, verifiedBot: false } });
    eq([low.visitor.kind, low.visitor.score, low.visitor.country], ["bot", 2, "VN"], "low score");
    // Verified search engine: Googlebot is "search" only when Cloudflare verified it.
    const google = await as({ "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" }, { botManagement: { score: 1, verifiedBot: true, verifiedBotCategory: "Search Engine Crawler" } });
    eq([google.visitor.kind, google.visitor.verified], ["search", true], "verified Googlebot");
    // No bot score at all (no Bot Management): a bare browser UA falls back to header checks.
    const noScore = await as(bare, { country: "DE" });
    eq(noScore.visitor.kind, "unknown", "bare browser UA without a score");
    const scored = await as(bare, { botManagement: { score: 80, verifiedBot: false } });
    eq(scored.visitor.kind, "human", "bare browser UA with a good score");
    return `placeholder request.cf ${placeholder} (Miniflare's fake, not a real score)`;
  });

  // ---- KV sessions ---------------------------------------------------------------------------
  await S("sessions in KV (kvSessionStore): state survives across requests", async () => {
    const u = new Client(dev.url, BROWSER);
    eq((await u.post("/counter")).json.n, 1, "first");
    eq((await u.post("/counter")).json.n, 2, "second");
    const ns = await explorer(dev, "/storage/kv/namespaces");
    const sessions = (ns.result ?? []).find((n: { title: string }) => /SESSIONS/i.test(n.title));
    check(sessions, `no SESSIONS namespace: ${JSON.stringify(ns).slice(0, 200)}`);
    const keys = await explorer(dev, `/storage/kv/namespaces/${sessions.id}/keys`);
    check(JSON.stringify(keys).includes("miu_session:"), `keys: ${JSON.stringify(keys).slice(0, 200)}`);
  });

  // ---- Cloudflare Workflows ------------------------------------------------------------------
  await S("Cloudflare Workflows: createCloudflareWorkflow runs steps + sleep to completion", async () => {
    const created = await c.post("/workflows/k1");
    check(created.status === 200, `create ${created.status}: ${created.text.slice(0, 400)}`);
    const t0 = performance.now();
    const status = await waitFor(
      async () => {
        const s = (await c.get("/workflows/k1")).json?.status;
        return s && (s.status === "complete" || s.status === "errored") ? s : null;
      },
      30_000,
      "the workflow to finish",
      250,
    );
    check(status.status === "complete", `workflow status: ${JSON.stringify(status).slice(0, 500)}`);
    eq((await mark("wf:k1"))?.total, 42, "workflow output in KV");
    return `complete in ${Math.round(performance.now() - t0)} ms (includes a 1 s step.sleep)`;
  });
  void sleep;
}
