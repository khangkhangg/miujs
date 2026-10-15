import { describe, expect, test } from "bun:test";
import { AGENTS, ROBOTS_ONLY_AI, createClassifier, classifyUserAgent } from "../src/index.ts";

const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0";
const SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15";

describe("classifyUserAgent", () => {
  const cases: [string, string, string | undefined][] = [
    ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)", "ai", "GPTBot"],
    ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot", "ai", "ChatGPT-User"],
    ["Mozilla/5.0 (compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)", "ai", "OAI-SearchBot"],
    ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)", "ai", "ClaudeBot"],
    ["Claude-User/1.0", "ai", "Claude-User"],
    ["Claude-SearchBot/1.0", "ai", "Claude-SearchBot"],
    ["anthropic-ai", "ai", "anthropic-ai"],
    ["CCBot/2.0 (https://commoncrawl.org/faq/)", "ai", "CCBot"],
    ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)", "ai", "PerplexityBot"],
    ["Perplexity-User/1.0", "ai", "Perplexity-User"],
    ["Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)", "ai", "Bytespider"],
    ["GoogleOther", "ai", "GoogleOther"],
    ["Mozilla/5.0 (compatible; Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot)", "ai", "Amazonbot"],
    ["meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)", "ai", "meta-externalagent"],
    ["meta-externalfetcher/1.1", "ai", "meta-externalfetcher"],
    ["cohere-ai", "ai", "cohere-ai"],
    ["Mozilla/5.0 (compatible; Diffbot/0.1)", "ai", "Diffbot"],
    ["Mozilla/5.0 (compatible; YouBot/1.0)", "ai", "YouBot"],
    ["ImagesiftBot", "ai", "ImagesiftBot"],
    ["Timpibot/0.8", "ai", "Timpibot"],
    ["omgili/0.5 +http://omgili.com", "ai", "omgili"],
    ["DuckAssistBot/1.2", "ai", "DuckAssistBot"],
    ["MistralAI-User/1.0", "ai", "MistralAI-User"],
    ["Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "search", "Googlebot"],
    ["Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)", "search", "Bingbot"],
    ["DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)", "search", "DuckDuckBot"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.1 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)", "search", "Applebot"],
    ["Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)", "search", "YandexBot"],
    ["Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)", "search", "Baiduspider"],
    ["curl/8.4.0", "bot", "curl"],
    ["Wget/1.21", "bot", "Wget"],
    ["python-requests/2.31.0", "bot", "python-requests"],
    ["python-httpx/0.27.0", "bot", "httpx"],
    ["Python/3.11 aiohttp/3.9.1", "bot", "aiohttp"],
    ["Go-http-client/2.0", "bot", "Go-http-client"],
    ["node-fetch/1.0 (+https://github.com/bitinn/node-fetch)", "bot", "node-fetch"],
    ["axios/1.6.0", "bot", "axios"],
    ["okhttp/4.12.0", "bot", "okhttp"],
    ["Java/17.0.2", "bot", "Java/"],
    ["libwww-perl/6.72", "bot", "libwww"],
    ["Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36", "bot", "HeadlessChrome"],
    ["Mozilla/5.0 (Unknown; Linux x86_64) AppleWebKit/538.1 (KHTML, like Gecko) PhantomJS/2.1.1 Safari/538.1", "bot", "PhantomJS"],
    ["Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)", "bot", "AhrefsBot"],
    ["Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)", "bot", "SemrushBot"],
    ["SomeCrawler/1.0", "bot", "SomeCrawler"],
    ["my-scraper", "bot", "my-scraper"],
  ];
  for (const [ua, kind, name] of cases) {
    test(`${name ?? ua}: ${kind}`, () => {
      const c = classifyUserAgent(ua);
      expect(c.kind).toBe(kind as never);
      expect(c.name).toBe(name);
    });
  }

  test("browsers are browsers, and say whether they always send sec-fetch-*", () => {
    expect(classifyUserAgent(CHROME)).toMatchObject({ kind: "browser", secFetch: true });
    expect(classifyUserAgent(FIREFOX)).toMatchObject({ kind: "browser", secFetch: true });
    // Safari sent no sec-fetch-* before 16.4, and the version in the UA is frozen: never required.
    expect(classifyUserAgent(SAFARI)).toMatchObject({ kind: "browser", secFetch: false });
    // Chrome 75 predates sec-fetch-*.
    expect(classifyUserAgent(CHROME.replace("129.0.0.0", "75.0.3770.0")).secFetch).toBe(false);
  });

  test("a phone brand ending in bot is not a bot", () => {
    expect(classifyUserAgent("Mozilla/5.0 (Linux; Android 9; CUBOT X19) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36").kind).toBe("browser");
  });

  test("no user agent, or one that is neither a browser nor a known agent, is other", () => {
    expect(classifyUserAgent(null).kind).toBe("none");
    expect(classifyUserAgent("").kind).toBe("none");
    expect(classifyUserAgent("MyApp/1.0").kind).toBe("other");
  });

  test("the longest name wins when two start at the same place", () => {
    const c = createClassifier([...AGENTS, { token: "Googlebot-News", kind: "bot" }]);
    expect(c("Googlebot-News").name).toBe("Googlebot-News");
    expect(c("Googlebot/2.1").name).toBe("Googlebot");
  });

  test("the list can be replaced, and tokens are literal text", () => {
    const c = createClassifier([{ token: "a.b", kind: "ai", name: "AB" }]);
    expect(c("x a.b y")).toMatchObject({ kind: "ai", name: "AB" });
    expect(c("x aXb y").kind).toBe("other");
    // Generic automation words still apply with a custom list.
    expect(c("FooBot/1").kind).toBe("bot");
  });

  test("repeated user agents return the memoized result, and the memo is bounded", () => {
    const c = createClassifier(AGENTS, { memo: 10 });
    const a = c(CHROME);
    expect(c(CHROME)).toBe(a);
    for (let i = 0; i < 100; i++) c(`MyApp/${i}`);
    expect(c.memoSize()).toBeLessThanOrEqual(10);
  });

  test("robots-only AI tokens (Google-Extended, Applebot-Extended) are listed for robots.txt", () => {
    expect(ROBOTS_ONLY_AI).toEqual(expect.arrayContaining(["Google-Extended", "Applebot-Extended"]));
    expect(AGENTS.some((a) => a.token === "Google-Extended")).toBe(false);
  });
});
