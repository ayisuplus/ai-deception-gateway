import assert from "node:assert/strict";
import test from "node:test";
import {
  signBotRequest,
  signMessageRequest,
  signTrapToken,
  verifyBotRequest,
  verifyTrapToken,
} from "../src/security.js";

test("trap tokens verify and reject tampering or expiry", () => {
  const secret = "test-secret-that-is-at-least-thirty-two-bytes";
  const now = Date.now();
  const token = signTrapToken(
    { session: "session", node: "node", depth: 2, variant: "baseline", exp: Math.floor(now / 1000) + 60 },
    secret,
  );
  assert.equal(verifyTrapToken(token, secret, now).valid, true);
  assert.equal(verifyTrapToken(`${token}x`, secret, now).reason, "signature");
  assert.equal(verifyTrapToken(token, secret, now + 120_000).reason, "expired");
});

test("prototype bot signatures bind identity, method, path, and timestamp", () => {
  const secret = "verified-bot-secret-at-least-32-bytes";
  const timestamp = Date.now();
  const signature = signBotRequest({ method: "GET", path: "/content/research", timestamp, botId: "search", secret });
  const request = {
    method: "GET",
    url: "/content/research",
    headers: new Headers({
      "x-aidg-bot-id": "search",
      "x-aidg-timestamp": String(timestamp),
      "x-aidg-signature": signature,
    }),
  };
  assert.equal(verifyBotRequest(request, new Map([["search", secret]]), timestamp).verified, true);
  request.url = "/content/research?role=admin";
  assert.equal(verifyBotRequest(request, new Map([["search", secret]]), timestamp).verified, false);
  request.url = "/content/other";
  assert.equal(verifyBotRequest(request, new Map([["search", secret]]), timestamp).verified, false);
});

test("http message signatures verify, reject tampering, and enforce freshness", () => {
  const secret = "edge-verified-secret-at-least-32-bytes";
  const bots = new Map([["edge-search", secret]]);
  const now = Date.now();
  const created = Math.floor(now / 1000);
  const signed = signMessageRequest({
    method: "GET",
    path: "/content/research",
    keyId: "edge-search",
    secret,
    created,
  });
  const request = {
    method: "GET",
    url: "/content/research",
    headers: new Headers({
      host: "local",
      "signature-input": signed.signatureInput,
      signature: signed.signature,
    }),
  };
  assert.deepEqual(verifyBotRequest(request, bots, now), {
    verified: true,
    botId: "edge-search",
    mechanism: "http-message-signature",
  });

  assert.equal(verifyBotRequest({ ...request, url: "/content/other" }, bots, now).verified, false);

  const wrongKey = signMessageRequest({
    method: "GET",
    path: "/content/research",
    keyId: "edge-search",
    secret: "wrong-secret-that-is-at-least-32-bytes",
    created,
  });
  const wrongKeyRequest = {
    ...request,
    headers: new Headers({
      host: "local",
      "signature-input": wrongKey.signatureInput,
      signature: wrongKey.signature,
    }),
  };
  assert.equal(verifyBotRequest(wrongKeyRequest, bots, now).verified, false);

  const stale = signMessageRequest({
    method: "GET",
    path: "/content/research",
    keyId: "edge-search",
    secret,
    created: created - 600,
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
