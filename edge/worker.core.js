import { loadConfig } from "../src/config.js";
import { handleGatewayRequest } from "../src/core.js";
import { Telemetry } from "../src/metrics.js";

// Edge adapter (runtime-agnostic): builds a gateway context from platform env
// bindings and returns a standard fetch handler. Works in Cloudflare Workers,
// Deno, Bun, and plain Node — anything with Request/Response. Tested in Node.
//
// Telemetry is per-isolate in-memory: rate-limit marks do not propagate
// across edge isolates. Multi-isolate deployments need a KV/Durable-Object
// adapter behind the same Map-like seam as src/shared-state.js.

const CONFIG_ENV_KEYS = {
  AIDG_MODE: "mode",
  AIDG_ORIGIN_URL: "originUrl",
  AIDG_TOKEN_SECRET: "tokenSecret",
  AIDG_FINGERPRINT_SALT: "fingerprintSalt",
  AIDG_TOKEN_TTL_SECONDS: "tokenTtlSeconds",
  AIDG_BRANCH_FACTOR: "branchFactor",
  AIDG_AUTO_BLOCK_DEPTH: "autoBlockDepth",
  AIDG_AUTO_BLOCK: "autoBlock",
  AIDG_DEBUG_HEADERS: "debugHeaders",
  AIDG_OBSERVE_ONLY: "observeOnly",
  AIDG_ADMIN_TOKEN: "adminToken",
  AIDG_MAX_EVENTS: "maxEvents",
  AIDG_MAX_PAGE_CACHE: "maxPageCache",
  AIDG_VERIFIED_BOTS: "verifiedBots",
  AIDG_REVERSE_CTA_GATE: "reverseCtaGate",
  AIDG_TRUST_FORWARDED_FOR: "trustForwardedFor",
};

export function createEdgeFetch(assetScript, env = {}) {
  const overrides = {};
  for (const [envKey, overrideKey] of Object.entries(CONFIG_ENV_KEYS)) {
    if (env[envKey] != null) overrides[overrideKey] = env[envKey];
  }
  const config = loadConfig(overrides);
  const telemetry = new Telemetry(config.maxEvents);
  const gateway = {
    config,
    telemetry,
    state: { mode: config.mode, pageCache: new Map() },
    allowLegacyRoutes: !config.originUrl,
    assetScript,
  };
  return (request) => {
    const peerAddress = request.headers.get("cf-connecting-ip") ?? "unknown";
    return handleGatewayRequest(gateway, request, peerAddress);
  };
}
