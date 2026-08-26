import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

function toBase64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function fromBase64Url(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function hmac(value, secret) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

export function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createSessionId() {
  return randomBytes(12).toString("base64url");
}

export function deriveNodeId(parentNode, childIndex, depth, secret) {
  return createHmac("sha256", secret)
    .update(`${parentNode}:${childIndex}:${depth}`)
    .digest("hex")
    .slice(0, 20);
}

export function signTrapToken(payload, secret) {
  const encoded = toBase64Url(JSON.stringify(payload));
  return `${encoded}.${hmac(encoded, secret)}`;
}

export function verifyTrapToken(token, secret, now = Date.now()) {
  if (typeof token !== "string" || token.length > 4096) {
    return { valid: false, reason: "malformed" };
  }
  const separator = token.lastIndexOf(".");
  if (separator <= 0) return { valid: false, reason: "malformed" };

  const encoded = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (!safeEqual(signature, hmac(encoded, secret))) {
    return { valid: false, reason: "signature" };
  }

  try {
    const payload = JSON.parse(fromBase64Url(encoded));
    if (
      !payload ||
      typeof payload.session !== "string" ||
      typeof payload.node !== "string" ||
      !Number.isInteger(payload.depth) ||
      payload.depth < 0 ||
      typeof payload.exp !== "number"
    ) {
      return { valid: false, reason: "payload" };
    }
    if (payload.exp * 1000 < now) return { valid: false, reason: "expired" };
    return { valid: true, payload };
  } catch {
    return { valid: false, reason: "payload" };
  }
}

export function fingerprintRequest(request, salt, trustForwardedFor = true, peerAddress = "unknown") {
  const forwarded = trustForwardedFor ? request.headers.get("x-forwarded-for") : null;
  const address = String(forwarded ?? peerAddress ?? "unknown").split(",")[0].trim();
  const userAgent = String(request.headers.get("user-agent") ?? "").slice(0, 512);
  return createHash("sha256")
    .update(`${salt}\n${address}\n${userAgent}`)
    .digest("hex")
    .slice(0, 24);
}

export function classifyUserAgent(userAgent = "") {
  const value = userAgent.toLowerCase();
  if (/googlebot|bingbot|duckduckbot|baiduspider/.test(value)) return "search-crawler";
  if (/gptbot|claudebot|anthropic|bytespider|ccbot|cohere-ai/.test(value)) return "ai-crawler";
  if (/crawler|spider|scraper|bot\b/.test(value)) return "generic-crawler";
  if (/curl|wget|python|httpie|libwww|go-http-client/.test(value)) return "automation-client";
  if (/mozilla|chrome|safari|firefox|edg\//.test(value)) return "browser";
  return value ? "unknown-client" : "missing";
}

export function botSignatureInput(method, path, timestamp, botId) {
  return `${method.toUpperCase()}\n${path}\n${timestamp}\n${botId}`;
}

export function signBotRequest({ method = "GET", path, timestamp, botId, secret }) {
  return hmac(botSignatureInput(method, path, timestamp, botId), secret);
}

export function verifyBotRequest(request, verifiedBots, now = Date.now()) {
  if (request.headers.get("signature-input") != null || request.headers.get("signature") != null) {
    return verifyMessageRequest(request, verifiedBots, now);
  }

  const botId = String(request.headers.get("x-aidg-bot-id") ?? "");
  const timestamp = String(request.headers.get("x-aidg-timestamp") ?? "");
  const signature = String(request.headers.get("x-aidg-signature") ?? "");
  if (!botId && !timestamp && !signature) return { verified: false, reason: "absent" };
  if (!botId || !timestamp || !signature) return { verified: false, reason: "incomplete" };

  const secret = verifiedBots.get(botId);
  if (!secret) return { verified: false, reason: "unknown-bot" };
  const time = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(time) || Math.abs(now - time) > 5 * 60 * 1000) {
    return { verified: false, reason: "stale" };
  }

  const url = new URL(request.url, "http://local");
  const path = `${url.pathname}${url.search}`;
  const expected = signBotRequest({ method: request.method, path, timestamp, botId, secret });
  return safeEqual(signature, expected)
    ? { verified: true, botId, mechanism: "prototype-hmac" }
    : { verified: false, reason: "signature" };
}

// HTTP Message Signatures (RFC 9421) subset: a single hmac-sha256 signature
// whose keyid resolves through the same verifiedBots map as the prototype
// scheme. Derived components outside the set below and any body-dependent
// coverage (e.g. content-digest) are rejected as unsupported.

const MESSAGE_SIGNATURE_ALGORITHM = "hmac-sha256";

function derivedComponentValue(request, url, name) {
  switch (name) {
    case "@method": return request.method.toLowerCase();
    case "@path": return url.pathname;
    case "@query": return url.search || "?";
    case "@authority": return url.host.toLowerCase();
    case "@scheme": return url.protocol.replace(":", "").toLowerCase();
    case "@target-uri": return url.toString();
    case "@request-target": return `${url.pathname}${url.search}`;
    default: return null;
  }
}

function parseSignatureInput(header) {
  const match = String(header).match(/^\s*([A-Za-z0-9_-]+)\s*=\s*\(([^)]*)\)\s*(.*)$/);
  if (!match) return null;
  const [, label, componentList, paramSource] = match;
  const components = [...componentList.matchAll(/"([^"]+)"/g)].map((item) => item[1]);
  if (!label || components.length === 0) return null;
  const params = [];
  for (const part of paramSource.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) return null;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    params.push([key, value]);
  }
  return { label, components, params };
}

function serializeSignatureParams(components, params) {
  const list = components.map((name) => `"${name}"`).join(" ");
  const suffix = params
    .map(([key, value]) => `;${key}=${/^-?\d+$/.test(value) ? value : `"${value}"`}`)
    .join("");
  return `(${list})${suffix}`;
}

function signatureBase(request, components, params) {
  const url = new URL(request.url, `http://${request.headers.get("host") ?? "local"}`);
  const lines = [];
  for (const name of components) {
    let value;
    if (name.startsWith("@")) {
      value = derivedComponentValue(request, url, name);
      if (value == null) return { error: "unsupported-component" };
    } else {
      const header = request.headers[name.toLowerCase()];
      if (header == null) return { error: "missing-covered-header" };
      value = String(header).trim();
    }
    lines.push(`"${name}": ${value}`);
  }
  lines.push(`"@signature-params": ${serializeSignatureParams(components, params)}`);
  return { base: lines.join("\n") };
}

export function signMessageRequest({
  method = "GET",
  path,
  authority = "local",
  scheme = "http",
  keyId,
  secret,
  created = Math.floor(Date.now() / 1000),
  expires,
  components = ["@method", "@path", "@authority"],
}) {
  const params = created == null ? [] : [["created", String(created)]];
  if (expires != null) params.push(["expires", String(expires)]);
  params.push(["keyid", keyId], ["alg", MESSAGE_SIGNATURE_ALGORITHM]);
  const url = new URL(path, `${scheme}://${authority}`);
  const request = {
    method,
    url: `${url.pathname}${url.search}`,
    headers: new Headers({ host: authority }),
  };
  const { base, error } = signatureBase(request, components, params);
  if (error) throw new Error(`cannot sign: ${error}`);
  const signature = createHmac("sha256", secret).update(base).digest("base64");
  return {
    signatureInput: `sig1=${serializeSignatureParams(components, params)}`,
    signature: `sig1=:${signature}:`,
  };
}

export function verifyMessageRequest(request, verifiedBots, now = Date.now()) {
  const inputHeader = request.headers.get("signature-input");
  const signatureHeader = request.headers.get("signature");
  if (inputHeader == null && signatureHeader == null) return { verified: false, reason: "absent" };
  if (inputHeader == null || signatureHeader == null) return { verified: false, reason: "incomplete" };

  const parsed = parseSignatureInput(inputHeader);
  if (!parsed) return { verified: false, reason: "malformed" };
  const params = Object.fromEntries(parsed.params);
  if ((params.alg ?? MESSAGE_SIGNATURE_ALGORITHM) !== MESSAGE_SIGNATURE_ALGORITHM) {
    return { verified: false, reason: "unsupported-alg" };
  }
  // Coverage floor: a valid signature must bind the request target, otherwise
  // one captured signature replays across every URL on the host.
  if (!parsed.components.includes("@method") || !parsed.components.includes("@path")) {
    return { verified: false, reason: "insufficient-coverage" };
  }
  const secret = verifiedBots.get(params.keyid ?? "");
  if (!secret) return { verified: false, reason: "unknown-bot" };

  const nowSeconds = Math.floor(now / 1000);
  const created = Number.parseInt(params.created ?? "", 10);
  const expires = Number.parseInt(params.expires ?? "", 10);
  // Freshness is mandatory: without a created timestamp a captured signature
  // replays forever.
  if (!Number.isFinite(created)) return { verified: false, reason: "created-required" };
  if (Math.abs(nowSeconds - created) > 300) return { verified: false, reason: "stale" };
  if (Number.isFinite(expires) && nowSeconds > expires) return { verified: false, reason: "stale" }

  const signatureMatch = String(signatureHeader).match(
    new RegExp(`(?:^|,)\\s*${parsed.label}\\s*=\\s*:([^:]+):`),
  );
  if (!signatureMatch) return { verified: false, reason: "malformed" };

  const { base, error } = signatureBase(request, parsed.components, parsed.params);
  if (error) return { verified: false, reason: error };
  const expected = createHmac("sha256", secret).update(base).digest("base64");
  return safeEqual(signatureMatch[1], expected)
    ? { verified: true, botId: params.keyid, mechanism: "http-message-signature" }
    : { verified: false, reason: "signature" };
}
