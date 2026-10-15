// robots.txt generation: AI crawlers opted out, everyone else under your own rules.

import { ROBOTS_ONLY_AI, type AgentEntry } from "./agents.ts";

export interface RobotsOptions {
  /** One group disallowing `/` for every AI agent in the list, plus robots-only tokens (Google-Extended, ...). Default true. */
  disallowAI?: boolean;
  /** Paths disallowed for everyone (`User-agent: *`). */
  disallow?: string[];
  /** Paths explicitly allowed for everyone. */
  allow?: string[];
  sitemap?: string | string[];
  /** Appended as is. */
  extra?: string;
}

export function renderRobots(opts: RobotsOptions, agents: readonly AgentEntry[]): string {
  const lines: string[] = [];
  if (opts.disallowAI !== false) {
    const names = new Set<string>();
    for (const a of agents) if (a.kind === "ai") names.add(a.name ?? a.token);
    for (const t of ROBOTS_ONLY_AI) names.add(t);
    for (const n of names) lines.push(`User-agent: ${n}`);
    lines.push("Disallow: /", "");
  }
  lines.push("User-agent: *");
  for (const p of opts.allow ?? []) lines.push(`Allow: ${p}`);
  for (const p of opts.disallow ?? []) lines.push(`Disallow: ${p}`);
  if (!opts.allow?.length && !opts.disallow?.length) lines.push("Allow: /");
  const maps = opts.sitemap === undefined ? [] : Array.isArray(opts.sitemap) ? opts.sitemap : [opts.sitemap];
  if (maps.length) lines.push("");
  for (const s of maps) lines.push(`Sitemap: ${s}`);
  if (opts.extra) lines.push("", opts.extra.trim());
  return lines.join("\n") + "\n";
}
