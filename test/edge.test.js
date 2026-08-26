import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import test from "node:test";
import { createEdgeFetch } from "../edge/worker.core.js";
import { extractLinks } from "../benchmark/clients.js";
import {
  ADMIN_API_PREFIX,
  BLACK_HOLE_ASSET_PATH,
  HEALTH_PATH,
  LAB_HOME_PATH,
  TRAP_PREFIX,
} from "../src/routes.js";
import { renderCanonicalResearch } from "../src/templates.js";

const ASSET = readFileSync(new URL("../public/black-hole.v1.js", import.meta.url));

function makeFetch(env = {}) {
  return createEdgeFetch(ASSET, {
    AIDG_TOKEN_SECRET: "edge-test-token-secret-at-least-32b",
    AIDG_FINGERPRINT_SALT: "edge-test-fingerprint-salt-32",
    ...env,
  });
}

test("edge handler serves health, lab home, and the visual asset", async () => {
  const fetcher = makeFetch();
  const health = await fetcher(new Request(`https://edge.test${HEALTH_PATH}`));
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);

  const home = await fetcher(new Request(`https://edge.test${LAB_HOME_PATH}`));
  assert.match(await home.text(), /data-black-hole-scene="home"/);

  const asset = await fetcher(new Request(`https://edge.test${BLACK_HOLE_ASSET_PATH}`));
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("content-type"), /^text\/javascript/);
  assert.match(asset.headers.get("cache-control"), /immutable/);
});

test("edge demo mode traps suspicious crawlers and serves decoys", async () => {
  const fetcher = makeFetch({ AIDG_MODE: "labyrinth" });
  const browser = await fetcher(new Request("https://edge.test/content/research", {
    headers: { "User-Agent": "Mozilla/5.0 Chrome/130.0", "Accept-Language": "zh-CN", Accept: "text/html" },
  }));
  assert.equal(await browser.text(), renderCanonicalResearch());

  const crawler = await fetcher(new Request("https://edge.test/content/research", {
    headers: { "User-Agent": "GPTBot/1.0", Accept: "text/html" },
  }));
  const trap = extractLinks(await crawler.text(), "https://edge.test")
    .find((link) => link.url.includes(TRAP_PREFIX));
  assert.ok(trap);
  const decoy = await fetcher(new Request(trap.url, {
    headers: { "User-Agent": "GPTBot/1.0", Accept: "text/html" },
  }));
  assert.equal(decoy.status, 200);
  assert.match(await decoy.text(), /data-black-hole-scene="trap"/);
});

test("edge admin API rejects non-loopback without a token and accepts with one", async () => {
  const open = makeFetch();
  const forbidden = await open(new Request(`https://edge.test${ADMIN_API_PREFIX}/summary`, {
    headers: { "CF-Connecting-IP": "203.0.113.9" },
  }));
  assert.equal(forbidden.status, 403);

  const locked = makeFetch({ AIDG_ADMIN_TOKEN: "edge-admin-token" });
  const denied = await locked(new Request(`https://edge.test${ADMIN_API_PREFIX}/summary`, {
    headers: { Authorization: "Bearer wrong" },
  }));
  assert.equal(denied.status, 401);
  const allowed = await locked(new Request(`https://edge.test${ADMIN_API_PREFIX}/summary`, {
    headers: { Authorization: "Bearer edge-admin-token" },
  }));
  assert.equal(allowed.status, 200);
});

test("edge proxy mode passes through public content without leaking credentials", async () => {
  const upstream = [];
  const origin = http.createServer((request, response) => {
    upstream.push({ ...request.headers });
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<!doctype html><html><body><main>Edge origin content</main></body></html>");
  });
  await new Promise((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const { port } = origin.address();
  try {
    const fetcher = makeFetch({ AIDG_ORIGIN_URL: `http://127.0.0.1:${port}/` });
    const response = await fetcher(new Request("https://edge.test/article", {
      headers: {
        "User-Agent": "Mozilla/5.0 Chrome/130.0",
        Accept: "text/html",
        Cookie: "session=must-not-leak",
        Authorization: "Bearer must-not-leak",
      },
    }));
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Edge origin content/);
    assert.equal(upstream[0].cookie, undefined);
    assert.equal(upstream[0].authorization, undefined);

    const reserved = await fetcher(new Request("https://edge.test/__event-horizon/not-a-route"));
    assert.equal(reserved.status, 404);
    assert.equal(upstream.length, 1);
  } finally {
    await new Promise((resolve, reject) => origin.close((error) => (error ? reject(error) : resolve())));
  }
});
