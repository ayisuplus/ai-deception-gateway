import http from "node:http";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { handleGatewayRequest } from "./core.js";
import { loadConfig, MODES } from "./config.js";
import { Telemetry } from "./metrics.js";
import { toWebRequest, writeWebResponse } from "./node-adapter.js";
import { SharedFingerprintMap } from "./shared-state.js";

const BLACK_HOLE_SCRIPT = readFileSync(
  new URL("../public/black-hole.v1.js", import.meta.url),
);

export function createGateway(overrides = {}) {
  const config = loadConfig(overrides);
  const allowLegacyRoutes = !config.originUrl;
  const telemetry = new Telemetry(
    config.maxEvents,
    config.sharedStatePath ? new SharedFingerprintMap(config.sharedStatePath) : null,
  );
  const state = { mode: config.mode, pageCache: new Map() };
  const gateway = {
    config,
    telemetry,
    state,
    allowLegacyRoutes,
    assetScript: overrides.blackHoleScript ?? BLACK_HOLE_SCRIPT,
  };

  const server = http.createServer(async (nodeRequest, nodeResponse) => {
    try {
      const request = await toWebRequest(nodeRequest, {
        withBody: !["GET", "HEAD"].includes(nodeRequest.method),
      });
      const response = await handleGatewayRequest(
        gateway,
        request,
        nodeRequest.socket.remoteAddress,
      );
      await writeWebResponse(nodeResponse, response);
    } catch (error) {
      if (nodeResponse.headersSent) {
        nodeResponse.destroy();
        return;
      }
      const status = error.statusCode ?? 502;
      const message = status >= 500 ? "Gateway Error" : error.message;
      nodeResponse.writeHead(status, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      });
      nodeResponse.end(message);
    }
  });

  return {
    config,
    telemetry,
    state,
    server,
    setMode(mode) {
      if (!MODES.includes(mode)) throw new Error(`Unknown mode: ${mode}`);
      state.mode = mode;
    },
    reset() {
      telemetry.reset();
      state.pageCache.clear();
    },
    async start(port = config.port, host = config.host) {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
      });
      return server.address();
    },
    async stop() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
