import { definePlugin, type Context } from "miujs";
import { webErrors } from "./errors.ts";

export type CspDirectives = Record<string, string[]>;

export interface SecureHeadersOptions {
  /**
   * Who may embed this site in a frame (CSP `frame-ancestors`). A route can override it for one
   * response with `ctx.state.frameAncestors = ["https://listings.example.com"]`; a response whose
   * own CSP already has `frame-ancestors` gets no X-Frame-Options. Default `["'none'"]`, which
   * also sends `X-Frame-Options: DENY`. `["'self'"]` sends `SAMEORIGIN`; any other origin drops
   * X-Frame-Options (it cannot list origins) and relies on CSP.
   */
  frameAncestors?: string[];
  /**
   * A Content-Security-Policy. `true` uses a strict default; an object lists directives
   * (camelCase or kebab-case keys). A per-request nonce is added to `script-src`, and to
   * `style-src` unless it allows `'unsafe-inline'`. Read it with `nonce(ctx)`.
   */
  csp?: boolean | CspDirectives;
  /** HSTS, sent only over https. Default `{ maxAge: 31536000, includeSubDomains: true }`. */
  hsts?: false | { maxAge?: number; includeSubDomains?: boolean; preload?: boolean };
  /** Feature → allowlist (`[]` = disabled, `["self"]`, origins). Merged over the defaults; `false` sends none. */
  permissionsPolicy?: false | Record<string, string[]>;
  /** Default `strict-origin-when-cross-origin`. */
  referrerPolicy?: string;
}

const NONCE_SLOT = "{nonce}";

/** Strict but practical default: same-origin everything, WebAssembly allowed (3D decoders), no plugins. */
export const DEFAULT_CSP: CspDirectives = {
  "default-src": ["'self'"],
  "script-src": ["'self'", "'wasm-unsafe-eval'"],
  "style-src": ["'self'", "'unsafe-inline'"],
  "img-src": ["'self'", "data:", "blob:"],
  "media-src": ["'self'", "blob:"],
  "font-src": ["'self'", "data:"],
  "connect-src": ["'self'"],
  "worker-src": ["'self'", "blob:"],
  "object-src": ["'none'"],
  "base-uri": ["'self'"],
  "form-action": ["'self'"],
};

export const DEFAULT_PERMISSIONS_POLICY: Record<string, string[]> = {
  accelerometer: [],
  camera: [],
  "display-capture": [],
  geolocation: [],
  gyroscope: [],
  magnetometer: [],
  microphone: [],
  midi: [],
  payment: [],
  usb: [],
  fullscreen: ["self"],
};

const SOURCE = /^[^\s;,\0-\x1f\x7f"]+$/;

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
}

function checkSources(where: string, values: string[]): void {
  for (const v of values) {
    if (typeof v !== "string" || !SOURCE.test(v)) {
      throw webErrors.config(`Invalid ${where} value ${JSON.stringify(v)}`, `Pass one source per array item, e.g. ["'self'", "https://listings.example.com"]. Values cannot contain spaces, ";" or ",".`);
    }
  }
}

function buildCsp(csp: SecureHeadersOptions["csp"], frameAncestors: string[]): string {
  const parts: string[] = [];
  if (csp) {
    const directives = csp === true ? DEFAULT_CSP : csp;
    for (const [rawName, values] of Object.entries(directives)) {
      const name = kebab(rawName);
      if (!/^[a-z]+(?:-[a-z]+)*$/.test(name)) throw webErrors.config(`Invalid CSP directive name ${JSON.stringify(rawName)}`, "Use directive names such as scriptSrc or \"script-src\".");
      if (name === "frame-ancestors") throw webErrors.config("Set frame-ancestors with the `frameAncestors` option", "Move it: secureHeaders({ frameAncestors: [...], csp: {...} }). It also controls X-Frame-Options.");
      checkSources(`CSP ${name}`, values);
      const list = [...values];
      if (name === "script-src" || (name === "style-src" && !list.includes("'unsafe-inline'"))) list.push(`'nonce-${NONCE_SLOT}'`);
      parts.push(list.length ? `${name} ${list.join(" ")}` : name);
    }
  }
  parts.push(`frame-ancestors ${frameAncestors.join(" ")}`);
  return parts.join("; ");
}

function buildPermissions(pp: Record<string, string[]>): string {
  return Object.entries(pp)
    .map(([feature, list]) => {
      if (!/^[a-z0-9-]+$/.test(feature)) throw webErrors.config(`Invalid Permissions-Policy feature ${JSON.stringify(feature)}`, "Use feature names such as camera or xr-spatial-tracking.");
      checkSources(`Permissions-Policy ${feature}`, list);
      return `${feature}=(${list.map((v) => (v === "self" || v === "*" ? v : `"${v}"`)).join(" ")})`;
    })
    .join(", ");
}

function xfoFor(list: string[]): string | null {
  if (list.length === 1 && list[0] === "'none'") return "DENY";
  if (list.length === 1 && list[0] === "'self'") return "SAMEORIGIN";
  return null;
}

function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** The CSP nonce for this request, for `<script nonce="…">`. Needs `secureHeaders({ csp })`. */
export function nonce(ctx: Pick<Context, "state">): string {
  const n = ctx.state.cspNonce;
  if (typeof n !== "string") throw webErrors.noNonce();
  return n;
}

function isHttps(ctx: Context): boolean {
  if (ctx.req.url.startsWith("https:")) return true;
  // Browsers ignore HSTS received over plain http, so trusting this header cannot do harm.
  return ctx.headers.get("x-forwarded-proto")?.split(",")[0].trim().toLowerCase() === "https";
}

/**
 * Baseline security headers on every response: nosniff, Referrer-Policy, X-Frame-Options +
 * CSP frame-ancestors, Permissions-Policy, HSTS on https, and an optional CSP with nonce.
 * Headers a handler already set are left alone.
 */
export function secureHeaders(opts: SecureHeadersOptions = {}) {
  const frameAncestors = opts.frameAncestors ?? ["'none'"];
  checkSources("frameAncestors", frameAncestors);
  const xfo = xfoFor(frameAncestors);
  const cspTemplate = buildCsp(opts.csp, frameAncestors);
  // Per-request frameAncestors overrides, cached by value (routes use a handful of lists).
  const overrides = new Map<string, { csp: string; xfo: string | null }>();
  const forOverride = (list: unknown): { csp: string; xfo: string | null } => {
    if (!Array.isArray(list) || list.length === 0) {
      throw webErrors.config("ctx.state.frameAncestors must be a non-empty array of sources", `Set e.g. ctx.state.frameAncestors = ["https://listings.example.com"].`);
    }
    const key = list.join(" ");
    let hit = overrides.get(key);
    if (!hit) {
      checkSources("ctx.state.frameAncestors", list as string[]);
      hit = { csp: buildCsp(opts.csp, list as string[]), xfo: xfoFor(list as string[]) };
      if (overrides.size > 64) overrides.clear();
      overrides.set(key, hit);
    }
    return hit;
  };
  const wantsNonce = !!opts.csp;
  const permissions = opts.permissionsPolicy === false ? null : buildPermissions({ ...DEFAULT_PERMISSIONS_POLICY, ...opts.permissionsPolicy });
  const hsts =
    opts.hsts === false
      ? null
      : (() => {
          const h = opts.hsts ?? {};
          let v = `max-age=${h.maxAge ?? 31536000}`;
          if (h.includeSubDomains ?? true) v += "; includeSubDomains";
          if (h.preload) v += "; preload";
          return v;
        })();
  const fixed: [string, string][] = [
    ["x-content-type-options", "nosniff"],
    ["referrer-policy", opts.referrerPolicy ?? "strict-origin-when-cross-origin"],
  ];
  if (permissions) fixed.push(["permissions-policy", permissions]);

  return definePlugin({
    name: "secure-headers",
    onRequest(ctx: Context) {
      if (wantsNonce) ctx.state.cspNonce = newNonce();
    },
    onResponse(ctx: Context, res: Response) {
      let template = cspTemplate;
      let frameOptions = xfo;
      if (ctx.state.frameAncestors !== undefined) {
        try {
          ({ csp: template, xfo: frameOptions } = forOverride(ctx.state.frameAncestors));
        } catch (err) {
          // A bad override never reaches the header: answer with the error under the defaults.
          ctx.log.error("secureHeaders: invalid ctx.state.frameAncestors", { err });
          ctx.state.frameAncestors = undefined;
          const out = (err as { toResponse(): Response }).toResponse();
          for (const [k, v] of fixed) out.headers.set(k, v);
          if (xfo) out.headers.set("x-frame-options", xfo);
          out.headers.set("content-security-policy", cspTemplate.replaceAll(NONCE_SLOT, String(ctx.state.cspNonce ?? "")));
          return out;
        }
      }
      let csp = template;
      if (wantsNonce) {
        // Normally set in onRequest; an earlier hook may have short-circuited before it ran.
        if (typeof ctx.state.cspNonce !== "string") ctx.state.cspNonce = newNonce();
        csp = template.replaceAll(NONCE_SLOT, ctx.state.cspNonce as string);
      }
      const add: [string, string][] = [...fixed];
      // The response chose its own embedding policy: X-Frame-Options (which cannot list origins) would contradict it.
      const own = res.headers.get("content-security-policy");
      const ownFrame = own !== null && /(?:^|;)\s*frame-ancestors\b/i.test(own);
      if (frameOptions && !ownFrame) add.push(["x-frame-options", frameOptions]);
      add.push(["content-security-policy", csp]);
      if (hsts && isHttps(ctx)) add.push(["strict-transport-security", hsts]);
      const missing = add.filter(([k]) => !res.headers.has(k));
      if (!missing.length) return;
      try {
        for (const [k, v] of missing) res.headers.set(k, v);
        return;
      } catch {
        const copy = new Response(res.body, res);
        for (const [k, v] of missing) copy.headers.set(k, v);
        return copy;
      }
    },
    inspect() {
      return {
        frameAncestors,
        xFrameOptions: xfo,
        csp: cspTemplate,
        permissionsPolicy: permissions,
        hsts: hsts ? `${hsts} (https only)` : null,
      };
    },
  });
}
