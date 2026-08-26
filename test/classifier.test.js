import assert from "node:assert/strict";
import test from "node:test";
import { classifyRequest } from "../src/classifier.js";
import { loadConfig } from "../src/config.js";
import { signBotRequest } from "../src/security.js";

const now = Date.now();
const secret = "verified-search-secret-at-least-32-bytes";
const config = loadConfig({
  tokenSecret: "token-secret-at-least-thirty-two-bytes",
  fingerprintSalt: "fingerprint-salt-at-least-thirty-two",
  verifiedBots: new Map([["search", secret]]),
});

function classify(headers, url = "/content/research") {
  return classifyRequest(
    { method: "GET", url, headers: new Headers(headers) },
    { config, now, recentRequests: 0, trapDepth: -1 },
  );
}

test("browser-like traffic is allowed", () => {
  const result = classify({
    "user-agent": "Mozilla/5.0 Chrome/130.0",
    "accept-language": "zh-CN",
    accept: "text/html",
  });
  assert.equal(result.decision, "allow");
});

test("AI crawler traffic enters the tarpit decision", () => {
  const result = classify({ "user-agent": "GPTBot/1.0", accept: "text/html" });
  assert.equal(result.decision, "tarpit");
  assert.ok(result.score >= 50);
});

test("valid bot signature wins over crawler heuristics", () => {
  const timestamp = String(now);
  const signature = signBotRequest({ method: "GET", path: "/content/research", timestamp, botId: "search", secret });
  const result = classify({
    "user-agent": "SearchCrawler/1.0 crawler",
    "x-aidg-bot-id": "search",
    "x-aidg-timestamp": timestamp,
    "x-aidg-signature": signature,
  });
  assert.equal(result.decision, "allow");
  assert.equal(result.verifiedBotId, "search");
});
