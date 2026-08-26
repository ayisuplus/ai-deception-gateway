import { Buffer } from "node:buffer";
import {
  BLACK_HOLE_ASSET_PATH,
  BLACK_HOLE_CSP,
} from "./black-hole.js";
import { classifyRequest } from "./classifier.js";
import { MODES } from "./config.js";
import {
  createEntryToken,
  renderDecoyPage,
  renderInlineNoise,
  renderTrapAnchor,
} from "./decoys.js";
import {
  createHoneyArchiveEntryToken,
  isHoneyArchivePayload,
  renderHoneyArchiveAnchor,
  renderHoneyArchiveResource,
} from "./honey-archive.js";
import { fingerprintRequest, safeEqual, verifyTrapToken } from "./security.js";
import {
  renderBlocked,
  renderCanonicalResearch,
  renderDashboard,
  renderHome,
} from "./templates.js";
import {
  ADMIN_API_PREFIX,
  ADMIN_PATH,
  ARCHIVE_PREFIX,
  EVENT_HORIZON_PREFIX,
  HEALTH_PATH,
  LAB_HOME_PATH,
  LEGACY_ROUTES,
  TRAP_PREFIX,
} from "./routes.js";

// Runtime-agnostic request core. Everything here speaks standard web API
// (Request/Response/Headers); runtimes (node:http adapter in app.js, edge
// worker in edge/) only convert I/O and supply a gateway context:
// { config, telemetry, state, allowLegacyRoutes, assetScript }.

const HTML_SECURITY_HEADERS = Object.freeze({
  "Content-Type": "text/html; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
});

// RFC 7230 §6.1 hop-by-hop headers plus credential headers that must never
// reach the origin. Connection-nominated headers are stripped per request in
// upstreamRequestHeaders.
const UPSTREAM_REQUEST_BLOCKLIST = new Set([
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "host",
  "keep-alive",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const UPSTREAM_RESPONSE_BLOCKLIST = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "www-authenticate",
]);

function json(value) {
  return Buffer.from(JSON.stringify(value));
}

function isLoopback(peerAddress) {
  return peerAddress === "127.0.0.1" || peerAddress === "::1" || peerAddress === "::ffff:127.0.0.1";
}

function adminAuthorized(request, config, peerAddress) {
  if (!config.adminToken) return isLoopback(peerAddress);
  return safeEqual(String(request.headers.get("authorization") ?? ""), `Bearer ${config.adminToken}`);
}

async function readJsonBody(request, maximum = 4096) {
  const text = await request.text();
  if (Buffer.byteLength(text) > maximum) {
    throw Object.assign(new Error("request body too large"), { statusCode: 413 });
  }
  if (text.length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("invalid JSON"), { statusCode: 400 });
  }
}

function injectBeforePageEnd(html, addition) {
  // Prefer </body>: "</main>" is likelier to appear inside a page's own script
  // strings, which would break the document for the tarpitted client.
  const lowered = html.toLowerCase();
  const index = Math.max(lowered.lastIndexOf("</body>"), lowered.lastIndexOf("</main>"));
  if (index < 0) return `${html}${addition}`;
  return `${html.slice(0, index)}${addition}${html.slice(index)}`;
}

export function applyExperiment(html, mode, config) {
  if (mode === "none") return html;
  if (mode === "inline-noise") return injectBeforePageEnd(html, renderInlineNoise());
  if (mode === "honey-archive") {
    const token = createHoneyArchiveEntryToken({ config });
    return injectBeforePageEnd(html, renderHoneyArchiveAnchor(token));
  }
  const variant = mode === "context-labyrinth" ? "context" : "baseline";
  const token = createEntryToken({ variant, config });
  return injectBeforePageEnd(html, renderTrapAnchor(token));
}

function contentLength(body) {
  return Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body);
}

function makeResponse(status, body, headers = {}, method = "GET") {
  const bytes = contentLength(body);
  const suppliedLength = headers["Content-Length"] ?? headers["content-length"];
  const outputHeaders = { ...headers };
  delete outputHeaders["content-length"];
  delete outputHeaders["Content-Length"];
  outputHeaders["Content-Length"] = String(
    method === "HEAD" && suppliedLength != null ? suppliedLength : bytes,
  );
  const response = new Response(method === "HEAD" ? null : body, {
    status,
    headers: outputHeaders,
  });
  return { response, bytes };
}

function lruSet(cache, key, value, maximum) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > maximum) cache.delete(cache.keys().next().value);
}

function cachedPage(cache, token, render, maximum) {
  const cached = cache.get(token);
  if (cached != null) {
    cache.delete(token);
    cache.set(token, cached);
    return { page: cached, cacheHit: true };
  }
  const page = render();
  lruSet(cache, token, page, maximum);
  return { page, cacheHit: false };
}

export function cloneClassification(classification, decision, reason) {
  return {
    ...classification,
    decision,
    reasons: [...classification.reasons, reason],
  };
}

function publicClassification(request, telemetry, config, fingerprint, now) {
  const record = telemetry.getFingerprint(fingerprint);
  return classifyRequest(request, {
    config,
    now,
    recentRequests: telemetry.recentRequestCount(fingerprint, now),
    trapDepth: record.maxTrapDepth,
  });
}

function matchesRoute(pathname, canonical, legacy, allowLegacy) {
  return pathname === canonical || (allowLegacy && pathname === legacy);
}

function valueAfterPrefix(pathname, canonical, legacy, allowLegacy) {
  if (pathname.startsWith(canonical)) return pathname.slice(canonical.length);
  if (allowLegacy && pathname.startsWith(legacy)) return pathname.slice(legacy.length);
  return null;
}

export function isUtf8Html(contentType) {
  const normalized = contentType.toLowerCase();
  if (!normalized.includes("text/html")) return false;
  const charset = normalized.match(/charset\s*=\s*["']?([^;\s"']+)/)?.[1];
  return charset == null || charset === "utf-8" || charset === "utf8";
}

function jsonMethodNotAllowed(request) {
  return makeResponse(405, json({ error: "method not allowed" }), {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    Allow: "GET, HEAD",
  }, request.method);
}

export function makeBlockedPage(request) {
  return makeResponse(429, renderBlocked(), {
    ...HTML_SECURITY_HEADERS,
    "Cache-Control": "no-store",
    "Retry-After": "3600",
    "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
    "Content-Security-Policy": BLACK_HOLE_CSP,
  }, request.method);
}

function upstreamRequestHeaders(request) {
  const connectionNominated = new Set(
    String(request.headers.get("connection") ?? "")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  );
  const headers = {};
  for (const [name, value] of request.headers) {
    const normalized = name.toLowerCase();
    if (UPSTREAM_REQUEST_BLOCKLIST.has(normalized)) continue;
    if (connectionNominated.has(normalized)) continue;
    headers[name] = value;
  }
  headers["accept-encoding"] = "identity";
  return headers;
}

function upstreamResponseHeaders(upstream, target, modified) {
  const headers = {};
  upstream.headers.forEach((value, name) => {
    const normalized = name.toLowerCase();
    if (!UPSTREAM_RESPONSE_BLOCKLIST.has(normalized)) headers[name] = value;
  });

  const location = upstream.headers.get("location");
  if (location) {
    try {
      const resolved = new URL(location, target);
      headers.location = resolved.origin === target.origin
        ? `${resolved.pathname}${resolved.search}${resolved.hash}`
        : location;
    } catch {
      headers.location = location;
    }
  }

  if (modified) {
    for (const name of [
      "accept-ranges",
      "content-md5",
      "content-range",
      "digest",
      "etag",
      "expires",
      "last-modified",
    ]) delete headers[name];
    headers["cache-control"] = "private, no-store";
  }

  if (!headers["x-content-type-options"]) headers["x-content-type-options"] = "nosniff";
  return headers;
}

async function proxyToOrigin({ request, url, config, classification, mode }) {
  if (!["GET", "HEAD"].includes(request.method)) {
    const { response, bytes } = makeResponse(405, "Method Not Allowed", {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      Allow: "GET, HEAD",
    }, request.method);
    return { response, bytes, status: 405 };
  }
  const target = new URL(`${url.pathname.slice(1)}${url.search}`, config.originUrl);
  const upstream = await fetch(target, {
    method: request.method,
    headers: upstreamRequestHeaders(request),
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  let body = Buffer.from(await upstream.arrayBuffer());
  const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
  const originalBody = body;
  const canApplyExperiment =
    request.method === "GET" &&
    upstream.ok &&
    isUtf8Html(contentType) &&
    classification.decision === "tarpit" &&
    mode !== "none";
  if (canApplyExperiment) {
    body = Buffer.from(applyExperiment(body.toString("utf8"), mode, config));
  }
  const modified = canApplyExperiment && !body.equals(originalBody);
  const headers = upstreamResponseHeaders(upstream, target, modified);
  headers["content-type"] = contentType;
  if (request.method === "HEAD") {
    const upstreamLength = upstream.headers.get("content-length");
    if (upstreamLength != null) headers["Content-Length"] = upstreamLength;
  }
  const { response, bytes } = makeResponse(upstream.status, body, headers, request.method);
  return { response, bytes, status: upstream.status };
}

// Route handlers. Each receives the shared gateway context and the per-request
// ctx, and returns null when the route does not match, or a result object:
// { response, bytes, status, classification, record }. `record: true` asks the
// dispatcher to append a request event with the returned classification etc.

function handleHealth(gateway, ctx) {
  if (!matchesRoute(ctx.url.pathname, HEALTH_PATH, LEGACY_ROUTES.health, gateway.allowLegacyRoutes)) {
    return null;
  }
  const { response, bytes } = makeResponse(
    200,
    json({
      ok: true,
      mode: gateway.state.mode,
      uptimeSeconds: Math.floor((Date.now() - gateway.telemetry.startedAt) / 1000),
    }),
    { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    ctx.request.method,
  );
  return { response, bytes, status: 200, classification: ctx.classification, record: false };
}

function handleBlackHoleAsset(gateway, ctx) {
  if (!matchesRoute(
    ctx.url.pathname,
    BLACK_HOLE_ASSET_PATH,
    LEGACY_ROUTES.blackHoleAsset,
    gateway.allowLegacyRoutes,
  )) {
    return null;
  }
  if (!["GET", "HEAD"].includes(ctx.request.method)) {
    const { response, bytes } = makeResponse(405, "Method Not Allowed", {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      Allow: "GET, HEAD",
    }, ctx.request.method);
    return { response, bytes, status: 405, classification: ctx.classification, record: false };
  }
  const { response, bytes } = makeResponse(200, gateway.assetScript, {
    "Content-Type": "text/javascript; charset=utf-8",
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
  }, ctx.request.method);
  return { response, bytes, status: 200, classification: ctx.classification, record: false };
}

function handleRobotsTxt(gateway, ctx) {
  if (!gateway.allowLegacyRoutes || ctx.url.pathname !== "/robots.txt") return null;
  const body = `User-agent: *\nAllow: /\nDisallow: ${EVENT_HORIZON_PREFIX}/\n`;
  const { response, bytes } = makeResponse(
    200,
    body,
    { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=300" },
    ctx.request.method,
  );
  return { response, bytes, status: 200, classification: ctx.classification, record: true };
}

function handleAdminDashboard(gateway, ctx) {
  if (!matchesRoute(ctx.url.pathname, ADMIN_PATH, LEGACY_ROUTES.admin, gateway.allowLegacyRoutes)) {
    return null;
  }
  const dashboard = renderDashboard();
  const { response, bytes } = makeResponse(200, dashboard.html, {
    ...HTML_SECURITY_HEADERS,
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${dashboard.nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  }, ctx.request.method);
  return { response, bytes, status: 200, classification: ctx.classification, record: false };
}

async function handleAdminApi(gateway, ctx) {
  const suffix = valueAfterPrefix(
    ctx.url.pathname,
    `${ADMIN_API_PREFIX}/`,
    `${LEGACY_ROUTES.adminApiPrefix}/`,
    gateway.allowLegacyRoutes,
  );
  if (suffix == null) return null;
  const { config, state, telemetry } = gateway;
  const { request } = ctx;
  const respond = (status, value) => {
    const { response, bytes } = makeResponse(status, json(value), {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    }, request.method);
    return { response, bytes, status, classification: ctx.classification, record: false };
  };
  if (!adminAuthorized(request, config, ctx.peerAddress)) {
    return respond(config.adminToken ? 401 : 403, { error: "admin authorization required" });
  }
  if (request.method === "GET" && suffix === "summary") {
    return respond(200, telemetry.summary(state.mode));
  }
  if (request.method === "GET" && suffix === "events") {
    return respond(200, { events: telemetry.events.slice(-200) });
  }
  if (request.method === "GET" && suffix === "baseline") {
    return respond(200, {
      mode: state.mode,
      observeOnly: config.observeOnly,
      matrix: telemetry.baseline(),
    });
  }
  if (request.method === "POST" && suffix === "mode") {
    const body = await readJsonBody(request);
    if (!MODES.includes(body.mode)) {
      return respond(400, { error: `mode must be one of ${MODES.join(", ")}` });
    }
    state.mode = body.mode;
    return respond(200, { ok: true, mode: state.mode });
  }
  if (request.method === "POST" && suffix === "reset") {
    telemetry.reset();
    state.pageCache.clear();
    return respond(200, { ok: true });
  }
  return respond(404, { error: "not found" });
}

function handleArchiveResource(gateway, ctx) {
  const tokenValue = valueAfterPrefix(
    ctx.url.pathname,
    ARCHIVE_PREFIX,
    LEGACY_ROUTES.archivePrefix,
    gateway.allowLegacyRoutes,
  );
  if (tokenValue == null) return null;
  const { config, state, telemetry } = gateway;
  const { request, fingerprint, now } = ctx;

  if (!["GET", "HEAD"].includes(request.method)) {
    const { response, bytes } = jsonMethodNotAllowed(request);
    return {
      response,
      bytes,
      status: 405,
      classification: cloneClassification(ctx.classification, "observe", "archive-method-rejected"),
      record: true,
    };
  }
  if (telemetry.isBlocked(fingerprint)) {
    const { response, bytes } = makeResponse(429, json({ error: "request limited" }), {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Retry-After": "3600",
      "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
      "Content-Security-Policy": BLACK_HOLE_CSP,
    }, request.method);
    return {
      response,
      bytes,
      status: 429,
      classification: cloneClassification(ctx.classification, "block", "previously-marked"),
      record: true,
    };
  }

  const token = decodeURIComponent(tokenValue);
  const verified = verifyTrapToken(token, config.tokenSecret, now);
  if (!verified.valid || !isHoneyArchivePayload(verified.payload)) {
    const reason = verified.valid ? "payload" : verified.reason;
    const { response, bytes } = makeResponse(404, json({ error: "not found" }), {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    }, request.method);
    return {
      response,
      bytes,
      status: 404,
      classification: cloneClassification(ctx.classification, "observe", `invalid-archive-token:${reason}`),
      record: true,
    };
  }

  const { page: resource, cacheHit } = cachedPage(
    state.pageCache,
    token,
    () => renderHoneyArchiveResource(verified.payload, config),
    config.maxPageCache,
  );
  const classification = cloneClassification(ctx.classification, "tarpit", "valid-honey-archive-token");
  const { response, bytes } = makeResponse(200, resource.body, {
    "Content-Type": resource.contentType,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "public, max-age=3600, immutable",
    "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
  }, request.method);
  if (request.method === "GET") {
    telemetry.recordArchive({
      fingerprint,
      session: verified.payload.session,
      archiveId: verified.payload.archive,
      stage: resource.stage,
      index: resource.index,
      chunkCount: resource.chunkCount,
      keyCount: resource.keyCount,
      cacheHit,
      bytes,
      at: now,
    });
  }
  return { response, bytes, status: 200, classification, record: true };
}

function handleTrapPage(gateway, ctx) {
  const tokenValue = valueAfterPrefix(
    ctx.url.pathname,
    TRAP_PREFIX,
    LEGACY_ROUTES.trapPrefix,
    gateway.allowLegacyRoutes,
  );
  if (tokenValue == null) return null;
  const { config, state, telemetry } = gateway;
  const { request, fingerprint, now } = ctx;

  if (!["GET", "HEAD"].includes(request.method)) {
    const { response, bytes } = jsonMethodNotAllowed(request);
    return {
      response,
      bytes,
      status: 405,
      classification: cloneClassification(ctx.classification, "observe", "trap-method-rejected"),
      record: true,
    };
  }
  if (telemetry.isBlocked(fingerprint)) {
    const { response, bytes } = makeBlockedPage(request);
    return {
      response,
      bytes,
      status: 429,
      classification: cloneClassification(ctx.classification, "block", "previously-marked"),
      record: true,
    };
  }

  const token = decodeURIComponent(tokenValue);
  const verified = verifyTrapToken(token, config.tokenSecret, now);
  const labyrinthVariant = verified.valid &&
    ["baseline", "context"].includes(verified.payload.variant);
  if (!labyrinthVariant) {
    const reason = verified.valid ? "variant" : verified.reason;
    const { response, bytes } = makeResponse(404, "Not Found", {
      "Content-Type": "text/plain; charset=utf-8",
    }, request.method);
    return {
      response,
      bytes,
      status: 404,
      classification: cloneClassification(ctx.classification, "observe", `invalid-trap-token:${reason}`),
      record: true,
    };
  }

  const { page, cacheHit } = cachedPage(
    state.pageCache,
    token,
    () => renderDecoyPage(verified.payload, config, now),
    config.maxPageCache,
  );
  const classification = cloneClassification(ctx.classification, "tarpit", "valid-labyrinth-token");
  const { response, bytes } = makeResponse(200, page.html, {
    ...HTML_SECURITY_HEADERS,
    "Cache-Control": "public, max-age=3600, immutable",
    "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
    "Content-Security-Policy": BLACK_HOLE_CSP,
  }, request.method);
  if (request.method === "GET") {
    telemetry.recordTrap({
      fingerprint,
      session: verified.payload.session,
      node: verified.payload.node,
      depth: verified.payload.depth,
      variant: verified.payload.variant,
      cta: verified.payload.cta,
      cacheHit,
      bytes,
      at: now,
    });
    if (config.autoBlock && verified.payload.depth >= config.autoBlockDepth) {
      telemetry.markBlocked(fingerprint, `trap-depth-${verified.payload.depth}`, now);
    }
  }
  return { response, bytes, status: 200, classification, record: true };
}

function handleBlockedRequest(gateway, ctx) {
  let classification = ctx.classification;
  if (gateway.telemetry.isBlocked(ctx.fingerprint)) {
    classification = cloneClassification(classification, "block", "previously-marked");
  }
  if (classification.decision !== "block") return null;
  const { response, bytes } = makeBlockedPage(ctx.request);
  return { response, bytes, status: 429, classification, record: true };
}

function handleLabHome(gateway, ctx) {
  const isLabHome = ctx.url.pathname === LAB_HOME_PATH ||
    ctx.url.pathname === EVENT_HORIZON_PREFIX ||
    (gateway.allowLegacyRoutes && ctx.url.pathname === LEGACY_ROUTES.home);
  if (!isLabHome) return null;
  const contentPath = gateway.contentPath ??
    (gateway.config.originUrl ? "/" : "/content/research");
  const { response, bytes } = makeResponse(200, renderHome(gateway.state.mode, contentPath), {
    ...HTML_SECURITY_HEADERS,
    "Cache-Control": "no-store",
    "Content-Security-Policy": BLACK_HOLE_CSP,
  }, ctx.request.method);
  return { response, bytes, status: 200, classification: ctx.classification, record: true };
}

function handleCanonicalResearch(gateway, ctx) {
  if (!gateway.allowLegacyRoutes || ctx.url.pathname !== "/content/research") return null;
  const { config, state } = gateway;
  let body = renderCanonicalResearch();
  if (ctx.classification.decision === "tarpit") body = applyExperiment(body, state.mode, config);
  const headers = {
    ...HTML_SECURITY_HEADERS,
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'",
  };
  if (config.debugHeaders) {
    headers["X-AIDG-Decision"] = ctx.classification.decision;
    headers["X-AIDG-Mode"] = state.mode;
  }
  const { response, bytes } = makeResponse(200, body, headers, ctx.request.method);
  return { response, bytes, status: 200, classification: ctx.classification, record: true };
}

function handleReservedNamespace(gateway, ctx) {
  if (!gateway.config.originUrl) return null;
  if (
    ctx.url.pathname !== EVENT_HORIZON_PREFIX &&
    !ctx.url.pathname.startsWith(`${EVENT_HORIZON_PREFIX}/`)
  ) {
    return null;
  }
  const { response, bytes } = makeResponse(404, "Not Found", {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
  }, ctx.request.method);
  return { response, bytes, status: 404, classification: ctx.classification, record: true };
}

async function handleOriginProxy(gateway, ctx) {
  if (!gateway.config.originUrl) return null;
  const { response, bytes, status } = await proxyToOrigin({
    request: ctx.request,
    url: ctx.url,
    config: gateway.config,
    classification: ctx.classification,
    mode: gateway.state.mode,
  });
  return { response, bytes, status, classification: ctx.classification, record: true };
}

function handleNotFound(_gateway, ctx) {
  const { response, bytes } = makeResponse(404, "Not Found", {
    "Content-Type": "text/plain; charset=utf-8",
  }, ctx.request.method);
  return { response, bytes, status: 404, classification: ctx.classification, record: true };
}

// Order is load-bearing: it preserves the previous monolithic dispatch.
const ROUTE_HANDLERS = Object.freeze([
  handleHealth,
  handleBlackHoleAsset,
  handleRobotsTxt,
  handleAdminDashboard,
  handleAdminApi,
  handleArchiveResource,
  handleTrapPage,
  handleBlockedRequest,
  handleLabHome,
  handleCanonicalResearch,
  handleReservedNamespace,
  handleOriginProxy,
  handleNotFound,
]);

export async function routeRequest(gateway, ctx) {
  for (const handler of ROUTE_HANDLERS) {
    const result = await handler(gateway, ctx);
    if (result != null) return result;
  }
  throw new Error("route table exhausted without a terminal handler");
}

// Build the per-request context every adapter shares: anonymous fingerprint,
// classification, and (in observe-only mode) the shadow decision.
export function prepareGatewayContext(gateway, request, peerAddress = "unknown") {
  const { config, telemetry } = gateway;
  const now = Date.now();
  const url = new URL(request.url);
  const fingerprint = fingerprintRequest(request, config.fingerprintSalt, config.trustForwardedFor, peerAddress);
  const classification = publicClassification(request, telemetry, config, fingerprint, now);
  // Observe-only mode: score every request but never alter a response.
  // The shadow decision (what would have happened) is what telemetry records.
  let shadowClassification = null;
  let effectiveClassification = classification;
  if (config.observeOnly && classification.decision !== "allow") {
    shadowClassification = classification;
    effectiveClassification = {
      ...classification,
      decision: "allow",
      reasons: [...classification.reasons, "observe-only"],
    };
  }
  return {
    request,
    url,
    fingerprint,
    classification: effectiveClassification,
    shadowClassification,
    peerAddress,
    now,
  };
}

// Append the request event for a completed route result / downstream response.
export function recordRequestEvent(gateway, ctx, { classification, status, bytes }) {
  gateway.telemetry.recordRequest({
    fingerprint: ctx.fingerprint,
    path: ctx.url.pathname,
    method: ctx.request.method,
    classification: ctx.shadowClassification ?? classification,
    mode: gateway.state.mode,
    status,
    bytes,
    at: ctx.now,
  });
}

// The single entry every runtime adapter calls. `gateway` is the shared
// context built by the adapter; `peerAddress` is the transport-level remote
// address (node socket, or the edge platform's connecting IP).
export async function handleGatewayRequest(gateway, request, peerAddress = "unknown") {
  const { telemetry, state } = gateway;
  const ctx = prepareGatewayContext(gateway, request, peerAddress);
  const { classification, url, fingerprint } = ctx;

  try {
    const result = await routeRequest(gateway, ctx);
    if (result.record) recordRequestEvent(gateway, ctx, result);
    return result.response;
  } catch (error) {
    const status = error.statusCode ?? 502;
    const message = status >= 500 ? "Gateway Error" : error.message;
    const { response, bytes } = makeResponse(status, message, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    });
    telemetry.recordRequest({
      fingerprint,
      path: url.pathname,
      method: request.method,
      classification: cloneClassification(
        ctx.shadowClassification ?? classification,
        "observe",
        `handler-error:${error.name}`,
      ),
      mode: state.mode,
      status,
      bytes,
      at: now,
    });
    return response;
  }
}
