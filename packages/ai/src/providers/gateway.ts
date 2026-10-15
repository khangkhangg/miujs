import { aiErrors } from "../errors.ts";
import type { Provider } from "../types.ts";
import type { GatewayRoute } from "./shared.ts";

export type { GatewayRoute } from "./shared.ts";

/**
 * Routes a provider through Cloudflare AI Gateway (caching, analytics, rate limits, fallbacks
 * configured in the Cloudflare dashboard). The provider keeps its own API key.
 *
 * ```ts
 * ai({ provider: aiGateway({ accountId, gatewayId }, anthropic()) })
 * ```
 */
export function aiGateway(gw: GatewayRoute, provider: Provider): Provider {
  const p = provider as Provider & { withGateway?: (gw: GatewayRoute) => Provider };
  if (typeof p.withGateway !== "function") {
    throw aiErrors.unsupported(provider.name, "Cloudflare AI Gateway routing", "Wrap anthropic(), openaiCompatible() or workersAI(), or point your provider's baseUrl at the gateway yourself.");
  }
  if (!gw?.accountId || !gw?.gatewayId) {
    throw aiErrors.config("aiGateway() needs accountId and gatewayId", "Pass aiGateway({ accountId, gatewayId }, provider) with the ids from the Cloudflare dashboard (AI > AI Gateway).");
  }
  return p.withGateway(gw);
}
