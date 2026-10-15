// User-Agent classification: which known crawler, automation tool or browser sent a request.
// Built from one list (exported, replaceable), compiled once into a regex, memoized per UA string.

/** What a User-Agent string says about its sender. Claims only: nothing here is verified. */
export type AgentKind = "ai" | "search" | "bot";

/** One known agent. `token` is literal text matched anywhere in the User-Agent, ignoring case. */
export interface AgentEntry {
  token: string;
  kind: AgentKind;
  /** Name reported in `ctx.visitor.name`. Default: `token`. */
  name?: string;
}

export interface UaClass {
  /**
   * `ai` / `search` / `bot`: a known agent or automation word. `browser`: looks like a browser.
   * `none`: no User-Agent. `other`: anything else (an app, an SDK, a typo).
   */
  kind: AgentKind | "browser" | "none" | "other";
  name?: string;
  /** A browser that always sends `sec-fetch-*` on secure origins (Chromium 80+, Firefox 90+). */
  secFetch: boolean;
}

const ai = (token: string, name?: string): AgentEntry => ({ token, kind: "ai", name });
const search = (token: string, name?: string): AgentEntry => ({ token, kind: "search", name });
const bot = (token: string, name?: string): AgentEntry => ({ token, kind: "bot", name });

/** AI crawlers, assistants and AI search fetchers that send their own User-Agent. */
export const AI_AGENTS: readonly AgentEntry[] = [
  ai("GPTBot"),
  ai("ChatGPT-User"),
  ai("OAI-SearchBot"),
  ai("ClaudeBot"),
  ai("Claude-User"),
  ai("Claude-SearchBot"),
  ai("Claude-Web"),
  ai("anthropic-ai"),
  ai("CCBot"),
  ai("PerplexityBot"),
  ai("Perplexity-User"),
  ai("Bytespider"),
  ai("GoogleOther"),
  ai("Google-CloudVertexBot"),
  ai("Amazonbot"),
  ai("meta-externalagent"),
  ai("meta-externalfetcher"),
  ai("FacebookBot"),
  ai("cohere-ai"),
  ai("cohere-training-data-crawler"),
  ai("Diffbot"),
  ai("YouBot"),
  ai("ImagesiftBot"),
  ai("Timpibot"),
  ai("omgilibot"),
  ai("omgili"),
  ai("DuckAssistBot"),
  ai("MistralAI-User"),
  ai("AI2Bot"),
  ai("PanguBot"),
  ai("Kangaroo Bot"),
];

/** Search engine crawlers. A claim only: `verified` needs Cloudflare or your `verify` hook. */
export const SEARCH_AGENTS: readonly AgentEntry[] = [
  search("Googlebot"),
  search("bingbot", "Bingbot"),
  search("DuckDuckBot"),
  search("Applebot"),
  search("YandexBot"),
  search("Baiduspider"),
  search("PetalBot"),
];

/** HTTP libraries, command line tools, headless browsers and link-preview fetchers. */
export const AUTOMATION_AGENTS: readonly AgentEntry[] = [
  bot("curl"),
  bot("Wget"),
  bot("python-requests"),
  bot("python-urllib"),
  bot("httpx"),
  bot("aiohttp"),
  bot("Scrapy"),
  bot("Go-http-client"),
  bot("node-fetch"),
  bot("undici"),
  bot("axios"),
  bot("got (https://github.com/sindresorhus/got)", "got"),
  bot("okhttp"),
  bot("Apache-HttpClient"),
  bot("Java/"),
  bot("libwww"),
  bot("HeadlessChrome"),
  bot("PhantomJS"),
  bot("Puppeteer"),
  bot("Playwright"),
  bot("Selenium"),
  bot("facebookexternalhit"),
  bot("Slackbot"),
  bot("Twitterbot"),
  bot("Discordbot"),
  bot("TelegramBot"),
];

/** The built-in list: `bots({ agents })` and `createClassifier()` default to it. */
export const AGENTS: readonly AgentEntry[] = [...AI_AGENTS, ...SEARCH_AGENTS, ...AUTOMATION_AGENTS];

/**
 * AI training opt-out tokens that only exist in robots.txt (no crawler sends them as a
 * User-Agent): blocking them by header is impossible, so `robots: { disallowAI: true }` lists them.
 */
export const ROBOTS_ONLY_AI: readonly string[] = ["Google-Extended", "Applebot-Extended", "Webzio-Extended", "cohere-training-data-crawler"];

// Generic automation words. Whole token (so the name is "AhrefsBot", not "Bot"); "CUBOT" is a phone.
const GENERIC = /(?<![a-z0-9._-])([a-z0-9._-]*(?:(?<!cu)bot|crawler|spider|scraper))(?![a-z])/i;
const BROWSER = /^Mozilla\/5\.0 .*(?:Chrome|Firefox|Safari|Edg|OPR|CriOS|FxiOS)\//;
const CHROME_VERSION = /Chrom(?:e|ium)\/(\d+)/;
const FIREFOX_VERSION = /Firefox\/(\d+)/;
const IOS_SHELL = /CriOS|FxiOS|EdgiOS/;
/** Longer strings are classified but not memoized, so the memo stays small. */
const MEMO_MAX_UA = 512;

const NONE: UaClass = Object.freeze({ kind: "none", secFetch: false }) as UaClass;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface Classifier {
  (ua: string | null | undefined): UaClass;
  /** Entries in the memo (for tests and `miu inspect`). */
  memoSize(): number;
}

/**
 * A User-Agent classifier over `agents` (default: the built-in list). Results for repeated UA
 * strings come from a bounded LRU (`memo` entries, default 1000), so a hit costs a Map lookup.
 */
export function createClassifier(agents: readonly AgentEntry[] = AGENTS, opts: { memo?: number } = {}): Classifier {
  const byToken = new Map<string, AgentEntry>();
  for (const a of agents) byToken.set(a.token.toLowerCase(), a);
  // Longest first: at the same position the first alternative wins ("Googlebot-News" over "Googlebot").
  const tokens = [...byToken.keys()].sort((a, b) => b.length - a.length);
  const known = tokens.length ? new RegExp(tokens.map(escape).join("|"), "i") : null;
  const memoMax = opts.memo ?? 1000;
  const memo = new Map<string, UaClass>();

  const compute = (ua: string): UaClass => {
    const m = known?.exec(ua);
    if (m) {
      const a = byToken.get(m[0].toLowerCase())!;
      return { kind: a.kind, name: a.name ?? a.token, secFetch: false };
    }
    const g = GENERIC.exec(ua);
    if (g) return { kind: "bot", name: g[1], secFetch: false };
    if (!BROWSER.test(ua)) return { kind: "other", secFetch: false };
    let secFetch = false;
    if (!IOS_SHELL.test(ua)) {
      const c = CHROME_VERSION.exec(ua);
      const f = c ? null : FIREFOX_VERSION.exec(ua);
      secFetch = c ? Number(c[1]) >= 80 : f ? Number(f[1]) >= 90 : false;
    }
    return { kind: "browser", secFetch };
  };

  const classify = ((ua: string | null | undefined): UaClass => {
    if (!ua) return NONE;
    const hit = memo.get(ua);
    if (hit !== undefined) {
      memo.delete(ua);
      memo.set(ua, hit);
      return hit;
    }
    const c = Object.freeze(compute(ua)) as UaClass;
    if (ua.length <= MEMO_MAX_UA && memoMax > 0) {
      memo.set(ua, c);
      if (memo.size > memoMax) memo.delete(memo.keys().next().value as string);
    }
    return c;
  }) as Classifier;
  classify.memoSize = () => memo.size;
  return classify;
}

/** The built-in classifier. */
export const classifyUserAgent: Classifier = createClassifier();
