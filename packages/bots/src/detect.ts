// Turns a request into a Visitor: Cloudflare signals first (request.cf on Workers, trusted cf-*
// headers behind Cloudflare elsewhere), then the User-Agent, then headers real browsers send.

import { classifyUserAgent, type Classifier, type UaClass } from "./agents.ts";

/**
 * - `human`: a browser that looks like one (or Cloudflare says so).
 * - `search`: a search engine crawler that Cloudflare (or your `verify` hook) verified.
 * - `ai`: an AI crawler, assistant or AI search fetcher (by User-Agent or Cloudflare category).
 * - `bot`: other automation, including unverified search engine claims.
 * - `unknown`: no User-Agent, a non-browser one, or a browser one without the headers browsers send.
 */
export type VisitorKind = "human" | "search" | "ai" | "bot" | "unknown";

/** What the plugin does with a request. */
export type Access = "full" | "partial" | "cached" | "block";

export interface Visitor {
  kind: VisitorKind;
  /** The agent's name, e.g. "GPTBot", "Googlebot", "curl". */
  name?: string;
  /** Cloudflare (verifiedBot) or your `verify` hook confirmed who it claims to be. */
  verified: boolean;
  /** Cloudflare bot score, 1–99; lower is more bot-like. Needs Bot Management. */
  score?: number;
  /** ISO 3166-1 alpha-2 country, e.g. "VN" ("T1" is Tor). */
  country?: string;
  region?: string;
  city?: string;
  /** Two-letter continent code, e.g. "EU". */
  continent?: string;
  asn?: number;
  asOrg?: string;
  /** What this visitor gets for this request. Set by the plugin's policy; "full" from detectVisitor(). */
  access: Access;
}

export interface DetectOptions {
  /** `"workerd"` reads `request.cf`. The plugin passes `ctx.runtime`. */
  runtime?: string;
  /**
   * Read Cloudflare's `cf-*` request headers (`cf-ipcountry`, `cf-ipcity`, `cf-region`,
   * `cf-ipcontinent`, `cf-bot-score`, `cf-verified-bot`) on Bun, Deno or Node. Only when every
   * request reaches the app through Cloudflare (Tunnel, or origin firewalled to Cloudflare's
   * IPs): otherwise a client sets them and claims to be a verified bot. Like `trustProxy`.
   */
  trustCloudflare?: boolean;
  /** Cloudflare bot scores below this are bots. Default 30 (Cloudflare's "likely automated" bound). */
  botScoreThreshold?: number;
  /** Require `sec-fetch-*` from Chromium/Firefox even on plain http. Default false. */
  strictHeaders?: boolean;
  /** Default: the built-in classifier. */
  classify?: Classifier;
}

/** Cloudflare's view of a request. */
export interface CfSignals {
  score?: number;
  verifiedBot: boolean;
  category?: string;
  jsPassed: boolean;
  country?: string;
  region?: string;
  city?: string;
  continent?: string;
  asn?: number;
  asOrg?: string;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const country = (v: unknown): string | undefined => {
  const s = str(v);
  return s === undefined || s === "XX" ? undefined : s.toUpperCase();
};
const score = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 1 && n <= 99 ? n : undefined;
};

/** Cloudflare signals for this request, or null when there are none we can trust. */
export function cloudflareSignals(req: Request, opts: DetectOptions = {}): CfSignals | null {
  if (opts.runtime === "workerd") {
    const cf = (req as { cf?: Record<string, any> }).cf;
    if (!cf || typeof cf !== "object") return null;
    const bm = cf.botManagement && typeof cf.botManagement === "object" ? cf.botManagement : {};
    const category = str(cf.verifiedBotCategory);
    return {
      score: score(bm.score),
      verifiedBot: bm.verifiedBot === true || category !== undefined,
      category,
      jsPassed: bm.jsDetection?.passed === true,
      country: country(cf.country),
      region: str(cf.region),
      city: str(cf.city),
      continent: str(cf.continent),
      asn: typeof cf.asn === "number" ? cf.asn : undefined,
      asOrg: str(cf.asOrganization),
    };
  }
  if (!opts.trustCloudflare) return null;
  const h = req.headers;
  const verified = h.get("cf-verified-bot");
  return {
    score: score(h.get("cf-bot-score")),
    verifiedBot: verified === "true" || verified === "1",
    category: undefined,
    jsPassed: false,
    country: country(h.get("cf-ipcountry")),
    region: str(h.get("cf-region")),
    city: str(h.get("cf-ipcity")),
    continent: str(h.get("cf-ipcontinent")),
    asn: undefined,
    asOrg: undefined,
  };
}

function kindOfCategory(category: string | undefined): VisitorKind {
  if (!category) return "bot";
  if (/^ai\b/i.test(category)) return "ai";
  if (/^search engine crawler$/i.test(category)) return "search";
  return "bot";
}

/** True when the browser must have sent sec-fetch-*: a secure context (https or localhost). */
function secureContext(req: Request, strict: boolean): boolean {
  if (strict) return true;
  const url = req.url;
  if (url.startsWith("https:")) return true;
  const proto = req.headers.get("x-forwarded-proto");
  if (proto !== null && proto.toLowerCase().startsWith("https")) return true;
  return LOCAL_ORIGIN.test(url);
}

const LOCAL_ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|[^/:?#]+\.localhost)(?::\d+)?(?:[/?#]|$)/i;

/** Decides the kind from the User-Agent class, Cloudflare signals and request headers. */
export function decideKind(req: Request, ua: UaClass, cf: CfSignals | null, opts: DetectOptions, verifiedByHook = false): { kind: VisitorKind; verified: boolean } {
  const verified = (cf?.verifiedBot ?? false) || verifiedByHook;
  // A self-declared agent stays what it says; a search engine claim needs verification.
  if (ua.kind === "ai" || ua.kind === "bot") return { kind: ua.kind, verified };
  if (ua.kind === "search") return { kind: verified ? "search" : "bot", verified };
  if (cf?.verifiedBot) return { kind: kindOfCategory(cf.category), verified: true };
  const threshold = opts.botScoreThreshold ?? 30;
  if (cf?.score !== undefined && cf.score < threshold) return { kind: "bot", verified: false };
  if (ua.kind !== "browser") return { kind: "unknown", verified: false };
  if (cf?.jsPassed || cf?.score !== undefined) return { kind: "human", verified: false };
  const h = req.headers;
  if (!h.has("accept-language")) return { kind: "unknown", verified: false };
  if (ua.secFetch && !h.has("sec-fetch-mode") && secureContext(req, opts.strictHeaders === true)) return { kind: "unknown", verified: false };
  return { kind: "human", verified: false };
}

export function buildVisitor(ua: UaClass, cf: CfSignals | null, decided: { kind: VisitorKind; verified: boolean }): Visitor {
  // Every field is always present (undefined when unknown): one object shape for every visitor.
  return {
    kind: decided.kind,
    name: ua.name,
    verified: decided.verified,
    score: cf?.score,
    country: cf?.country,
    region: cf?.region,
    city: cf?.city,
    continent: cf?.continent,
    asn: cf?.asn,
    asOrg: cf?.asOrg,
    access: "full",
  };
}

/**
 * Classifies a request without the plugin (in a script, a queue job, another plugin):
 *
 * ```ts
 * const v = detectVisitor(request, { runtime: "workerd" });
 * if (v.kind === "ai") ...
 * ```
 */
export function detectVisitor(req: Request, opts: DetectOptions = {}): Visitor {
  const ua = (opts.classify ?? classifyUserAgent)(req.headers.get("user-agent"));
  const cf = cloudflareSignals(req, opts);
  return buildVisitor(ua, cf, decideKind(req, ua, cf, opts));
}
