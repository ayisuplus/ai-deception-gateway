import { readFileSync } from "node:fs";
import {
  applyExperiment,
  cloneClassification,
  isUtf8Html,
  makeBlockedPage,
  prepareGatewayContext,
  recordRequestEvent,
  routeRequest,
} from "./core.js";
import { loadConfig } from "./config.js";
import { Telemetry } from "./metrics.js";
import { toWebRequest, writeWebResponse } from "./node-adapter.js";
import { EVENT_HORIZON_PREFIX } from "./routes.js";
import { SharedFingerprintMap } from "./shared-state.js";

const BLACK_HOLE_SCRIPT = readFileSync(
  new URL("../public/black-hole.v1.js", import.meta.url),
);

function inGatewayNamespace(pathname) {
  return pathname === EVENT_HORIZON_PREFIX || pathname.startsWith(`${EVENT_HORIZON_PREFIX}/`);
}

// Wrap res.write/res.end: count bytes for telemetry, and (only for tarpitted
// GETs) buffer the body so a trap entry can be injected before </body>.
// Non-HTML payloads bail out to streaming at the first write.
function captureResponse(nodeRequest, nodeResponse, { buffer, onFinish }) {
    const originalWrite = nodeResponse.write.bind(nodeResponse);
  const originalEnd = nodeResponse.end.bind(nodeResponse);
  const originalWriteHead = nodeResponse.writeHead.bind(nodeResponse);
  const state = { chunks: [], bytes: 0, buffering: buffer, flushed: false };

  // Defer explicit writeHead calls: node finalizes headers the moment
  // writeHead runs, after which setHeader/removeHeader throw. Route the call
  // through the header store instead so the transform can still adjust
  // cache-control, etag, and content-length at end(). Because the override
  // also intercepts node's own implicit writeHead on first body write, every
  // path that emits bytes must flush the stored headers explicitly first.
  nodeResponse.writeHead = (statusCode, ...args) => {
    nodeResponse.statusCode = statusCode;
    for (const arg of args) {
      if (typeof arg === "string") nodeResponse.statusMessage = arg;
      else if (arg && typeof arg === "object") {
        for (const [name, value] of Object.entries(arg)) nodeResponse.setHeader(name, value);
      }
    }
    return nodeResponse;
  };

  const flushHeaders = () => {
    if (state.flushed) return;
    state.flushed = true;
    originalWriteHead(nodeResponse.statusCode);
  };

  const bailToStreaming = () => {
    state.buffering = false;
    flushHeaders();
    for (const buffered of state.chunks) originalWrite(buffered);
    state.chunks.length = 0;
  };

  nodeResponse.write = (chunk, encoding, callback) => {
    state.bytes += chunk?.length ?? 0;
    if (state.buffering) {
      const type = nodeResponse.getHeader("content-type");
      if (type != null && !isUtf8Html(String(type))) bailToStreaming();
      if (state.buffering) {
        state.chunks.push(Buffer.from(chunk ?? ""));
        if (typeof encoding === "function") encoding();
        else if (callback) callback();
        return true;
      }
    }
    flushHeaders();
    return originalWrite(chunk, encoding, callback);
  };

  nodeResponse.end = (chunk, encoding, callback) => {
    if (typeof chunk === "function") {
      callback = chunk;
      chunk = undefined;
    } else if (typeof encoding === "function") {
      callback = encoding;
      encoding = undefined;
    }
    if (chunk) {
      state.bytes += chunk.length;
      if (state.buffering) state.chunks.push(Buffer.from(chunk));
    }
    if (state.buffering) {
      const type = nodeResponse.getHeader("content-type");
      let body = Buffer.concat(state.chunks);
      const injectable =
        nodeResponse.statusCode === 200 &&
        nodeRequest.method === "GET" &&
        type != null &&
        isUtf8Html(String(type));
      if (injectable) {
        body = Buffer.from(onFinish.transform(body.toString("utf8")));
        nodeResponse.setHeader("cache-control", "private, no-store");
        nodeResponse.removeHeader("etag");
      }
      nodeResponse.setHeader("content-length", String(body.length));
      state.bytes = body.length;
      onFinish.record(state.bytes);
      flushHeaders();
      originalEnd(body, callback);
      return;
    }
    onFinish.record(state.bytes);
    flushHeaders();
    originalEnd(chunk, encoding, callback);
  };
}

// Connect/Express-style middleware: the full shield for the host application
// itself. Serves the /__event-horizon/ namespace (labyrinth, honey archive,
// admin, asset, health), blocks marked fingerprints everywhere, and injects
// trap entries into tarpitted HTML responses from downstream handlers.
// Everything else passes through byte-identical; request bodies of host
// routes are never consumed.
export function createGatewayMiddleware(overrides = {}) {
  const config = loadConfig({ ...overrides, originUrl: "" });
  const telemetry = new Telemetry(
    config.maxEvents,
    config.sharedStatePath ? new SharedFingerprintMap(config.sharedStatePath) : null,
  );
  const gateway = {
    config,
    telemetry,
    state: { mode: config.mode, pageCache: new Map() },
    allowLegacyRoutes: false,
    assetScript: overrides.blackHoleScript ?? BLACK_HOLE_SCRIPT,
    contentPath: "/",
  };

  return async function gatewayMiddleware(nodeRequest, nodeResponse, next) {
    const peerAddress = nodeRequest.socket.remoteAddress;
    try {
      const namespace = nodeRequest.url.split("?")[0];
      const ownRoute = inGatewayNamespace(namespace);
      const request = await toWebRequest(nodeRequest, {
        withBody: ownRoute && !["GET", "HEAD"].includes(nodeRequest.method),
      });
      const ctx = prepareGatewayContext(gateway, request, peerAddress);

      if (ownRoute) {
        const result = await routeRequest(gateway, ctx);
        if (result.record) recordRequestEvent(gateway, ctx, result);
        await writeWebResponse(nodeResponse, result.response);
        return;
      }

      // Host path: only the block gate applies; the response stays downstream's.
      let classification = ctx.classification;
      if (telemetry.isBlocked(ctx.fingerprint)) {
        classification = cloneClassification(classification, "block", "previously-marked");
      }
      if (classification.decision === "block") {
        const { response, bytes } = makeBlockedPage(request);
        recordRequestEvent(gateway, ctx, { classification, status: 429, bytes });
        await writeWebResponse(nodeResponse, response);
        return;
      }

      const buffer =
        classification.decision === "tarpit" &&
        gateway.state.mode !== "none" &&
        nodeRequest.method === "GET";
      captureResponse(nodeRequest, nodeResponse, {
        buffer,
        onFinish: {
          transform: (html) => applyExperiment(html, gateway.state.mode, gateway.config),
          record: (bytes) => {
            recordRequestEvent(gateway, ctx, {
              classification,
              status: nodeResponse.statusCode,
              bytes,
            });
          },
        },
      });
      next();
    } catch (error) {
      next(error);
    }
  };
}
