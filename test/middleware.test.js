import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createGatewayMiddleware } from "../src/middleware.js";
import { extractLinks } from "../benchmark/clients.js";
import { HEALTH_PATH, TRAP_PREFIX } from "../src/routes.js";

const HOST_HTML = "<!doctype html><html><body><main>Host app content</main></body></html>";

function startHost(middlewareOptions = {}) {
  const middleware = createGatewayMiddleware({
    tokenSecret: "middleware-token-secret-at-least-32",
    fingerprintSalt: "middleware-fingerprint-salt-32",
    autoBlockDepth: 2,
    ...middlewareOptions,
  });
  const host = { calls: 0 };
  const server = http.createServer((request, response) => {
    middleware(request, response, (error) => {
      if (error) {
        response.writeHead(500, { "Content-Type": "text/plain" });
        response.end(`middleware error: ${error.message}`);
        return;
      }
      host.calls += 1;
      if (request.url === "/assets/site.css") {
        response.writeHead(200, { "Content-Type": "text/css", "Cache-Control": "public, max-age=600" });
        response.end("body{color:navy}");
        return;
      }
      if (request.method === "POST") {
        const chunks = [];
        request.on("data", (chunk) => chunks.push(chunk));
        request.on("end", () => {
          response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
          response.end(Buffer.concat(chunks));
        });
        return;
      }
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        ETag: '"host-v1"',
        "Cache-Control": "public, max-age=300",
      });
      response.end(HOST_HTML);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, host, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function stop(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

test("middleware serves its namespace and passes browsers through byte-identical", async () => {
  const { server, host, baseUrl } = await startHost();
  try {
    const health = await fetch(`${baseUrl}${HEALTH_PATH}`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);
    assert.equal(host.calls, 0);

    const browser = await fetch(`${baseUrl}/`, {
      headers: { "User-Agent": "Mozilla/5.0 Chrome/130.0", "Accept-Language": "zh-CN", Accept: "text/html" },
    });
    assert.equal(await browser.text(), HOST_HTML);
    assert.equal(browser.headers.get("etag"), '"host-v1"');
    assert.equal(host.calls, 1);
  } finally {
    await stop(server);
  }
});

test("middleware injects trap entries for tarpitted crawlers and serves the labyrinth", async () => {
  const { server, host, baseUrl } = await startHost({ mode: "labyrinth" });
  try {
    const headers = { "User-Agent": "GPTBot/1.0", Accept: "text/html" };
    const response = await fetch(`${baseUrl}/`, { headers });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.ok(body.includes("aidg-trap-entry"));
    assert.ok(body.indexOf("aidg-trap-entry") < body.toLowerCase().indexOf("</body>"));
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("etag"), null);
    assert.equal(response.headers.get("content-length"), String(Buffer.byteLength(body)));

    const trap = extractLinks(body, baseUrl).find((link) => link.url.includes(TRAP_PREFIX));
    assert.ok(trap);
    const callsBeforeTrap = host.calls;
    const decoy = await fetch(trap.url, { headers });
    assert.equal(decoy.status, 200);
    assert.match(await decoy.text(), /data-black-hole-scene="trap"/);
    assert.equal(host.calls, callsBeforeTrap);
  } finally {
    await stop(server);
  }
});

test("middleware blocks marked fingerprints on host paths", async () => {
  const { server, host, baseUrl } = await startHost({ mode: "labyrinth", autoBlockDepth: 2 });
  try {
    const headers = { "User-Agent": "AIDG-DepthCrawler/1.0 crawler", Accept: "text/html" };
    let response = await fetch(`${baseUrl}/`, { headers });
    let next = extractLinks(await response.text(), baseUrl)
      .find((link) => link.url.includes(TRAP_PREFIX));
    for (let depth = 0; depth <= 2; depth += 1) {
      response = await fetch(next.url, { headers });
      assert.equal(response.status, 200);
      next = extractLinks(await response.text(), baseUrl)[0];
    }
    const callsBeforeBlock = host.calls;
    response = await fetch(`${baseUrl}/`, { headers });
    assert.equal(response.status, 429);
    assert.match(await response.text(), /data-black-hole-scene="blocked"/);
    assert.equal(host.calls, callsBeforeBlock);
  } finally {
    await stop(server);
  }
});

test("middleware never consumes host request bodies", async () => {
  const { server, baseUrl } = await startHost();
  try {
    const response = await fetch(`${baseUrl}/form`, {
      method: "POST",
      headers: { "User-Agent": "Mozilla/5.0 Chrome/130.0", "Content-Type": "text/plain" },
      body: "host-owned-payload",
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "host-owned-payload");
  } finally {
    await stop(server);
  }
});

test("middleware streams non-HTML payloads to tarpitted crawlers untouched", async () => {
  const { server, baseUrl } = await startHost({ mode: "labyrinth" });
  try {
    const response = await fetch(`${baseUrl}/assets/site.css`, {
      headers: { "User-Agent": "GPTBot/1.0", Accept: "text/css" },
    });
    assert.equal(await response.text(), "body{color:navy}");
    assert.match(response.headers.get("cache-control"), /max-age=600/);
  } finally {
    await stop(server);
  }
});
