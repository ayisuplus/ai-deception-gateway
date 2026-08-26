import { randomBytes } from "node:crypto";

export const MODES = Object.freeze([
  "none",
  "inline-noise",
  "labyrinth",
  "context-labyrinth",
  "honey-archive",
]);

function parseBoolean(value, fallback) {
  if (value == null) return fallback;
  return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

function parseInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function parseVerifiedBots(value) {
  if (!value) return new Map();
  try {
    const parsed = JSON.parse(value);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new TypeError("expected a JSON object");
    }
    return new Map(
      Object.entries(parsed).filter(
        ([botId, secret]) => botId.length > 0 && typeof secret === "string" && secret.length >= 16,
      ),
    );
  } catch (error) {
    throw new Error(`Invalid AIDG_VERIFIED_BOTS: ${error.message}`);
  }
}

export function loadConfig(overrides = {}) {
  const env = (typeof process !== "undefined" && process.env) || {};
  const requestedMode = overrides.mode ?? env.AIDG_MODE ?? "labyrinth";
  if (!MODES.includes(requestedMode)) {
    throw new Error(`AIDG_MODE must be one of: ${MODES.join(", ")}`);
  }

  const tokenSecret = overrides.tokenSecret ?? env.AIDG_TOKEN_SECRET ?? randomBytes(32).toString("hex");
  const fingerprintSalt =
    overrides.fingerprintSalt ?? env.AIDG_FINGERPRINT_SALT ?? randomBytes(32).toString("hex");
  const rawOriginUrl = overrides.originUrl ?? env.AIDG_ORIGIN_URL ?? "";
  let originUrl = "";
  if (rawOriginUrl) {
    const parsedOrigin = new URL(rawOriginUrl);
    if (!["http:", "https:"].includes(parsedOrigin.protocol)) {
      throw new Error("AIDG_ORIGIN_URL must use http or https");
    }
    parsedOrigin.pathname = parsedOrigin.pathname.endsWith("/")
      ? parsedOrigin.pathname
      : `${parsedOrigin.pathname}/`;
    originUrl = parsedOrigin.toString();
  }

  return Object.freeze({
    host: overrides.host ?? env.HOST ?? "127.0.0.1",
    port: parseInteger(overrides.port ?? env.PORT, 8787, 0, 65535),
    originUrl,
    mode: requestedMode,
    tokenSecret,
    fingerprintSalt,
    tokenTtlSeconds: parseInteger(
      overrides.tokenTtlSeconds ?? env.AIDG_TOKEN_TTL_SECONDS,
      3600,
      60,
      86400,
    ),
    branchFactor: parseInteger(overrides.branchFactor ?? env.AIDG_BRANCH_FACTOR, 3, 1, 8),
    autoBlockDepth: parseInteger(
      overrides.autoBlockDepth ?? env.AIDG_AUTO_BLOCK_DEPTH,
      4,
      2,
      64,
    ),
    autoBlock: parseBoolean(overrides.autoBlock ?? env.AIDG_AUTO_BLOCK, true),
    debugHeaders: parseBoolean(overrides.debugHeaders ?? env.AIDG_DEBUG_HEADERS, false),
    observeOnly: parseBoolean(overrides.observeOnly ?? env.AIDG_OBSERVE_ONLY, false),
    sharedStatePath: overrides.sharedStatePath ?? env.AIDG_SHARED_STATE_PATH ?? "",
    reverseCtaGate: parseBoolean(overrides.reverseCtaGate ?? env.AIDG_REVERSE_CTA_GATE, false),
    trustForwardedFor: parseBoolean(overrides.trustForwardedFor ?? env.AIDG_TRUST_FORWARDED_FOR, true),
    adminToken: overrides.adminToken ?? env.AIDG_ADMIN_TOKEN ?? "",
    maxEvents: parseInteger(overrides.maxEvents ?? env.AIDG_MAX_EVENTS, 5000, 100, 100000),
    maxPageCache: parseInteger(
      overrides.maxPageCache ?? env.AIDG_MAX_PAGE_CACHE,
      2000,
      100,
      50000,
    ),
    verifiedBots:
      typeof overrides.verifiedBots === "string"
        ? parseVerifiedBots(overrides.verifiedBots)
        : overrides.verifiedBots instanceof Map
          ? new Map(overrides.verifiedBots)
          : parseVerifiedBots(env.AIDG_VERIFIED_BOTS),
  });
}
