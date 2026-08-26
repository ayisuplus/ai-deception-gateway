import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createGateway } from "../src/app.js";
import { extractLinks } from "../benchmark/clients.js";
import { ADMIN_API_PREFIX, ARCHIVE_PREFIX, TRAP_PREFIX } from "../src/routes.js";
import {
  signBotRequest,
  signMessageRequest,
  verifyBotRequest,
} from "../src/security.js";

async function withGateway(callback, overrides = {}) {
  const gateway = createGateway({
    port: 0,
    tokenSecret: "adversarial-token-secret-at-least-32-b",
    fingerprintSalt: "adversarial-fingerprint-salt-32",
    autoBlockDepth: 2,
    ...overrides,
  });
  const address = await gateway.start(0, "127.0.0.1");
  try {
    return await callback(gateway, `http://127.0.0.1:${address.port}`);
  } finally {
    await gateway.stop();
  }
}

test("message signatures without created or with stale timestamps are rejected", () => {
  const secret = "edge-verified-secret-at-least-32-bytes";
  const bots = new Map([["edge", secret]]);
  const now = Date.now();

  const unsigned = signMessageRequest({ method: "GET", path: "/x", keyId: "edge", secret, created: null });
  const request = {
    method: "GET",
    url: "/x",
    headers: new Headers({
      host: "local",
      "signature-input": unsigned.signatureInput,
      signature: unsigned.signature,
    }),
  };
  assert.equal(verifyBotRequest(request, bots, now).reason, "created-required");

  const stale = signMessageRequest({
    method: "GET",
    path: "/x",
    keyId: "edge",
    secret,
    created: Math.floor(now / 1000) - 600,
  });
  const staleRequest = {
    ...request,
    headers: new Headers({
      host: "local",
      "signature-input": stale.signatureInput,
      signature: stale.signature,
    }),
  };
  assert.equal(verifyBotRequest(staleRequest, bots, now).reason, "stale");
});

test("message signatures must cover the request target", () => {
  const secret = "edge-verified-secret-at-least-32-bytes";
  const bots = new Map([["edge", secret]]);
  const signed = signMessageRequest({
    method: "GET",
    path: "/x",
    keyId: "edge",
    secret,
    components: ["@authority"],
  });
  const request = {
    method: "GET",
    url: "/x",
    headers: new Headers({
      host: "local",
      "signature-input": signed.signatureInput,
      signature: signed.signature,
    }),
  };
  assert.equal(verifyBotRequest(request, bots).reason, "insufficient-coverage");
});

test("prototype bot signatures bind the query string", () => {
  const secret = "verified-bot-secret-at-least-32-bytes";
  const bots = new Map([["search", secret]]);
  const now = Date.now();
  const signature = signBotRequest({ method: "GET", path: "/data?role=admin", timestamp: now, botId: "search", secret });
  const headers = new Headers({
    "x-aidg-bot-id": "search",
    "x-aidg-timestamp": String(now),
    "x-aidg-signature": signature,
  });
  assert.equal(verifyBotRequest({ method: "GET", url: "/data?role=admin", headers }, bots, now).verified, true);
  assert.equal(verifyBotRequest({ method: "GET", url: "/data?role=user", headers }, bots, now).verified, false);
  assert.equal(verifyBotRequest({ method: "GET", url: "/data", headers }, bots, now).verified, false);
});

test("honey archive tokens are rejected at the labyrinth endpoint", async () => {
  await withGateway(async (gateway, baseUrl) => {
    const headers = { "User-Agent": "GPTBot/1.0", Accept: "text/html" };
    const content = await fetch(`${baseUrl}/content/research`, { headers });
    const archiveEntry = extractLinks(await content.text(), baseUrl)
      .find((link) => link.url.includes(ARCHIVE_PREFIX));
    assert.ok(archiveEntry);
    const confused = await fetch(archiveEntry.url.replace(ARCHIVE_PREFIX, TRAP_PREFIX), { headers });
    assert.equal(confused.status, 404);
  }, { mode: "honey-archive" });
});

test("admin API enforces the bearer token and rejects wrong credentials", async () => {
  await withGateway(async (gateway, baseUrl) => {
    const url = `${baseUrl}${ADMIN_API_PREFIX}/summary`;
    const missing = await fetch(url);
    assert.equal(missing.status, 401);
    const denied = await fetch(url, { headers: { Authorization: "Bearer wrong-token" } });
    assert.equal(denied.status, 401);
    const allowed = await fetch(url, { headers: { Authorization: "Bearer test-admin-token" } });
    assert.equal(allowed.status, 200);
  }, { adminToken: "test-admin-token" });
});

test("blocked fingerprints survive a flood of fresh visitors", async () => {
  await withGateway(async (gateway, baseUrl) => {
    gateway.telemetry.markBlocked("pinned-attacker", "trap-depth-4");
    for (let index = 0; index < 130; index += 1) {
      const response = await fetch(`${baseUrl}/content/research`, {
        headers: { "User-Agent": `AIDG-Flood/${index}` },
      });
      await response.text();
    }
    assert.equal(gateway.telemetry.isBlocked("pinned-attacker"), true);
    assert.ok(gateway.telemetry.fingerprints.size <= 100);
  }, { mode: "none", maxEvents: 100 });
});

test("shared blocked state survives an instance restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aidg-restart-"));
  const sharedStatePath = join(directory, "fingerprints.json");
  try {
    await withGateway(async (gatewayA) => {
      gatewayA.telemetry.markBlocked("repeat-offender", "trap-depth-4");
    }, { sharedStatePath });
    await withGateway(async (gatewayB) => {
      assert.equal(gatewayB.telemetry.isBlocked("repeat-offender"), true);
    }, { sharedStatePath });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("debounced flushes merge instead of clobbering peer marks", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aidg-merge-"));
  const sharedStatePath = join(directory, "fingerprints.json");
  try {
    await withGateway(async (gatewayA) => {
      await withGateway(async (gatewayB) => {
        gatewayA.telemetry.recordRequest({
          fingerprint: "a-visitor",
          path: "/x",
          method: "GET",
          classification: { decision: "allow", score: 0, reasons: [], userAgentClass: "browser" },
          mode: "none",
          status: 200,
          bytes: 1,
        });
        gatewayB.telemetry.markBlocked("b-attacker", "trap-depth-4");
        await delay(400);
        const persisted = new Map(JSON.parse(readFileSync(sharedStatePath, "utf8")));
        assert.equal(persisted.get("b-attacker")?.blocked, true);
        assert.ok(persisted.has("a-visitor"));
      }, { sharedStatePath });
    }, { sharedStatePath });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("forwarded-for is honored only when the deployment trusts it", async () => {
  const headersFor = (ip) => ({ "User-Agent": "AIDG-Xff/1.0", "X-Forwarded-For": ip });
  await withGateway(async (gateway, baseUrl) => {
    for (const ip of ["1.1.1.1", "2.2.2.2", "3.3.3.3"]) {
      await (await fetch(`${baseUrl}/content/research`, { headers: headersFor(ip) })).text();
    }
    assert.equal(gateway.telemetry.fingerprints.size, 1);
  }, { mode: "none", trustForwardedFor: false });

  await withGateway(async (gateway, baseUrl) => {
    for (const ip of ["1.1.1.1", "2.2.2.2", "3.3.3.3"]) {
      await (await fetch(`${baseUrl}/content/research`, { headers: headersFor(ip) })).text();
    }
    assert.equal(gateway.telemetry.fingerprints.size, 3);
  }, { mode: "none" });
});

test("decoy injection prefers the body end when no main element exists", async () => {
  const originBody = "<!doctype html><html><body><div>Origin fragment without main</div></body></html>";
  const origin = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(originBody);
  });
  await new Promise((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const { port } = origin.address();
  try {
    await withGateway(async (gateway, baseUrl) => {
      const crawler = await fetch(`${baseUrl}/article`, {
        headers: { "User-Agent": "GPTBot/1.0", Accept: "text/html" },
      });
      const body = (await crawler.text()).toLowerCase();
      const trapIndex = body.indexOf("aidg-trap-entry");
      assert.ok(trapIndex > 0);
      assert.ok(trapIndex < body.indexOf("</body>"));
    }, { mode: "labyrinth", originUrl: `http://127.0.0.1:${port}/` });
  } finally {
    await new Promise((resolve, reject) => origin.close((error) => (error ? reject(error) : resolve())));
  }
});
