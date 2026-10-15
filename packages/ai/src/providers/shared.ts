import type { Env } from "miujs";
import { aiErrors } from "../errors.ts";
import type { AIMessage, AIPart, Usage } from "../types.ts";

/** A Cloudflare AI Gateway a provider's traffic is routed through. */
export interface GatewayRoute {
  accountId: string;
  gatewayId: string;
  /** Gateway auth token (`cf-aig-authorization`), for authenticated gateways. */
  token?: string;
}

export const GATEWAY_BASE = "https://gateway.ai.cloudflare.com/v1";

export function gatewayUrl(gw: GatewayRoute, slug: string): string {
  return `${GATEWAY_BASE}/${encodeURIComponent(gw.accountId)}/${encodeURIComponent(gw.gatewayId)}/${slug}`;
}

export function resolveKey(provider: string, explicit: string | undefined, envName: string, env: Env): string {
  if (explicit) return explicit;
  const v = env?.[envName];
  if (typeof v === "string" && v) return v;
  throw aiErrors.missingKey(provider, envName);
}

export const trimSlash = (url: string) => url.replace(/\/+$/, "");

export function parts(content: AIMessage["content"]): AIPart[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

export function textOf(content: AIMessage["content"]): string {
  return typeof content === "string"
    ? content
    : content
        .filter((p): p is Extract<AIPart, { type: "text" }> => p.type === "text")
        .map((p) => p.text)
        .join("");
}

export function parseArgs(s: string | undefined | null): Record<string, unknown> {
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export function openaiUsage(u: any): Usage {
  return { inputTokens: u?.prompt_tokens ?? 0, outputTokens: u?.completion_tokens ?? 0 };
}

export const OPENAI_STOP: Record<string, string> = { stop: "end_turn", length: "max_tokens", tool_calls: "tool_use", function_call: "tool_use", content_filter: "refusal" };
