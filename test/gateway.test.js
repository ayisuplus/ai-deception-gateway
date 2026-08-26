import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGateway } from "../src/app.js";
import { extractLinks, runClient } from "../benchmark/clients.js";
import { blackHoleIntensity } from "../src/black-hole.js";
import { MODES } from "../src/config.js";
import {
  ADMIN_API_PREFIX,
  ADMIN_PATH,
  ARCHIVE_PREFIX,
  BLACK_HOLE_ASSET_PATH,
  HEALTH_PATH,
  LAB_HOME_PATH,
  TRAP_PREFIX,
} from "../src/routes.js";
import { signBotRequest, signMessageRequest } from "../src/security.js";
import { CANONICAL_MARKER, renderCanonicalResearch } from "../src/templates.js";

async function withGateway(callback, overrides = {}) {
  const gateway = createGateway({
    port: 0,
    tokenSecret: "integration-token-secret-at-least-32-bytes",
    fingerprintSalt: "integration-fingerprint-salt-at-least-32",
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

test("normal browser receives byte-identical canonical content in every mode", async () => {
  await withGateway(async (gateway, baseUrl) => {
    for (const mode of MODES) {
      gateway.reset();
      gateway.setMode(mode);
      const response = await fetch(`${baseUrl}/content/research`, {
        headers: { "User-Agent": "Mozilla/5.0 Chrome/130.0", "Accept-Language": "zh-CN", Accept: "text/html" },
      });
      assert.equal(await response.text(), renderCanonicalResearch());
    }
  });
});

test("event horizon home and visual asset use a single immutable same-origin script", async () => {
  await withGateway(async (gateway, baseUrl) => {
    const home = await fetch(`${baseUrl}${LAB_HOME_PATH}`, {
      headers: { "User-Agent": "Mozilla/5.0 Chrome/130.0", "Accept-Language": "zh-CN", Accept: "text/html" },
    });
    const homeBody = await home.text();
    assert.match(homeBody, /data-black-hole-scene="home"/);
    assert.match(homeBody, /data-black-hole-canvas/);
    assert.ok(homeBody.includes(`<script defer src="${BLACK_HOLE_ASSET_PATH}"></script>`));
    assert.match(home.headers.get("content-security-policy"), /script-src 'self'/);
    assert.match(home.headers.get("content-security-policy"), /connect-src 'none'/);

    const asset = await fetch(`${baseUrl}${BLACK_HOLE_ASSET_PATH}`);
    const source = await asset.text();
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-type"), /^text\/javascript/);
    assert.match(asset.headers.get("cache-control"), /max-age=31536000/);
    assert.match(asset.headers.get("cache-control"), /immutable/);
    assert.equal(asset.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.match(source, /blackHoleReady/);
    assert.match(source, /prefers-reduced-motion: reduce/);
    assert.match(source, /visibilitychange/);
    assert.match(source, /devicePixelRatio/);
    assert.match(source, /event-horizon-visual/);
    assert.match(source, /attachShadow/);
    assert.match(source, /disconnectedCallback/);
    assert.match(source, /ResizeObserver/);
    assert.ok(!/\bfetch\s*\(|XMLHttpRequest|WebSocket|https?:\/\//.test(source));
    assert.equal(gateway.telemetry.summary(gateway.state.mode).requests, 1);
  });
});

test("honey archive resolves, verifies, and decrypts only safe synthetic observations", async () => {
  await withGateway(async (gateway, baseUrl) => {
    const result = await runClient(baseUrl, "archive", { maxRequests: 16 });
    assert.equal(result.requests, 11);
    assert.equal(result.archivePages, 10);
    assert.equal(result.archiveCompleted, true);
    assert.equal(result.merkleVerified, true);
    assert.equal(result.archiveSyntheticNotice, true);
    assert.equal(result.archiveSafeFactsOnly, true);
    assert.equal(result.archiveDecryptionValid, true);
    assert.match(result.archiveCanary, /^HONEY-[A-F0-9]{20}$/);

    const summary = gateway.telemetry.summary(gateway.state.mode);
    assert.equal(summary.archiveVisits, 10);
    assert.equal(summary.archiveCompletions, 1);
    assert.equal(summary.blockedFingerprints, 0);
    assert.equal(summary.originArchiveRequests, 0);

    assert.ok(gateway.telemetry.events.every((event) => event.type !== "block_mark"));
  }, { mode: "honey-archive", autoBlock: true });
});

test("honey archive manifest is isolated, immutable, signed, and edge-cacheable", async () => {
  await withGateway(async (gateway, baseUrl) => {
    const headers = { "User-Agent": "GPTBot/1.0", Accept: "text/html,*/*" };
    const content = await fetch(`${baseUrl}/content/research`, { headers });
    const entry = extractLinks(await content.text(), baseUrl)
      .find((link) => link.url.includes(ARCHIVE_PREFIX));
    assert.ok(entry);
    assert.equal(entry.nofollow, true);

    const first = await fetch(entry.url, { headers });
    const firstBody = await first.text();
    const second = await fetch(entry.url, { headers });
    const secondBody = await second.text();
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(firstBody, secondBody);
    assert.match(first.headers.get("content-type"), /^application\/json/);
    assert.match(first.headers.get("cache-control"), /immutable/);
    assert.match(first.headers.get("x-robots-tag"), /noindex/);
    assert.ok(!/https?:\/\//i.test(firstBody));
    const manifest = JSON.parse(firstBody);
    assert.equal(manifest.kind, "manifest");
    assert.equal(manifest.cipher.algorithm, "AES-256-GCM");
    assert.equal(manifest.chunks.length, 4);
    assert.match(manifest.merkleRoot, /^[a-f0-9]{64}$/);

    const summary = gateway.telemetry.summary(gateway.state.mode);
    assert.equal(summary.archiveVisits, 2);
    assert.equal(summary.archiveCompletions, 0);
    assert.equal(summary.cacheMisses, 1);
    assert.equal(summary.cacheHits, 1);
  }, { mode: "honey-archive", autoBlock: false });
});

test("verified crawler receives canonical content while suspicious crawler receives a signed trap", async () => {
  const secret = "verified-search-secret-at-least-32-bytes";
  await withGateway(async (gateway, baseUrl) => {
    const timestamp = String(Date.now());
    const signature = signBotRequest({ method: "GET", path: "/content/research", timestamp, botId: "search", secret });
    const verified = await fetch(`${baseUrl}/content/research`, {
      headers: {
        "User-Agent": "SearchCrawler/1.0 crawler",
        "X-AIDG-Bot-Id": "search",
        "X-AIDG-Timestamp": timestamp,
        "X-AIDG-Signature": signature,
      },
    });
    assert.equal(await verified.text(), renderCanonicalResearch());

    const suspicious = await fetch(`${baseUrl}/content/research`, {
      headers: { "User-Agent": "GPTBot/1.0", Accept: "text/html" },
    });
    const body = await suspicious.text();
    assert.ok(body.includes(CANONICAL_MARKER));
    const trap = extractLinks(body, baseUrl).find((link) => link.url.includes(TRAP_PREFIX));
    assert.ok(trap);
    assert.equal(trap.nofollow, true);

    const trapResponse = await fetch(trap.url, { headers: { "User-Agent": "GPTBot/1.0", Accept: "text/html" } });
    const trapBody = await trapResponse.text();
    assert.equal(trapResponse.status, 200);
    assert.match(trapResponse.headers.get("x-robots-tag"), /noindex/);
    assert.match(trapResponse.headers.get("content-security-policy"), /script-src 'self'/);
    assert.match(trapResponse.headers.get("content-security-policy"), /connect-src 'none'/);
    assert.ok(!/href=["']https?:\/\//i.test(trapBody));
    const scripts = [...trapBody.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    assert.equal(scripts.length, 1);
    assert.ok(scripts[0][1].includes(`src="${BLACK_HOLE_ASSET_PATH}"`));
    assert.equal(scripts[0][2].trim(), "");
    assert.match(trapBody, /data-black-hole-scene="trap" data-depth="0" data-intensity="0\.2"/);
  }, { mode: "labyrinth", verifiedBots: new Map([["search", secret]]) });
});

test("deep traversal marks the anonymous fingerprint and rate-limits the next trap request", async () => {
  await withGateway(async (gateway, baseUrl) => {
    const headers = { "User-Agent": "AIDG-DepthCrawler/1.0 crawler", Accept: "text/html" };
    let response = await fetch(`${baseUrl}/content/research`, { headers });
    let body = await response.text();
    let next = extractLinks(body, baseUrl).find((link) => link.url.includes(TRAP_PREFIX));
    for (let depth = 0; depth <= 2; depth += 1) {
      response = await fetch(next.url, { headers });
      body = await response.text();
      assert.equal(response.status, 200);
      assert.ok(body.includes(`data-depth="${depth}" data-intensity="${blackHoleIntensity(depth)}"`));
      next = extractLinks(body, baseUrl)[0];
    }
    response = await fetch(next.url, { headers });
    body = await response.text();
    assert.equal(response.status, 429);
    assert.match(body, /data-black-hole-scene="blocked"/);
    assert.match(body, /信号已越过/);
    assert.match(response.headers.get("content-security-policy"), /script-src 'self'/);
    assert.equal(gateway.telemetry.summary(gateway.state.mode).blockedFingerprints, 1);
  }, { mode: "context-labyrinth", autoBlockDepth: 2 });
});

test("decoy page cache records a hit for a repeated signed URL", async () => {
  await withGateway(async (gateway, baseUrl) => {
    const headers = { "User-Agent": "AIDG-CacheCrawler/1.0 crawler", Accept: "text/html" };
    const content = await fetch(`${baseUrl}/content/research`, { headers });
    const trap = extractLinks(await content.text(), baseUrl).find((link) => link.url.includes(TRAP_PREFIX));
    await fetch(trap.url, { headers });
    await fetch(trap.url, { headers });
    const summary = gateway.telemetry.summary(gateway.state.mode);
    assert.equal(summary.cacheMisses, 1);
    assert.equal(summary.cacheHits, 1);
  }, { mode: "labyrinth", autoBlockDepth: 10 });
});

test("trap routes accept only GET and HEAD and record telemetry for GET only", async () => {
  await withGateway(async (gateway, baseUrl) => {
    const headers = { "User-Agent": "AIDG-MethodCrawler/1.0 crawler", Accept: "text/html" };
    const content = await fetch(`${baseUrl}/content/research`, { headers });
    const trap = extractLinks(await content.text(), baseUrl)
      .find((link) => link.url.includes(TRAP_PREFIX));
    assert.ok(trap);

    const posted = await fetch(trap.url, { method: "POST", headers });
    assert.equal(posted.status, 405);
    assert.equal(posted.headers.get("allow"), "GET, HEAD");

    const before = gateway.telemetry.summary(gateway.state.mode).trapVisits;
    const headed = await fetch(trap.url, { method: "HEAD", headers });
    assert.equal(headed.status, 200);
    assert.equal(await headed.text(), "");
    assert.equal(gateway.telemetry.summary(gateway.state.mode).trapVisits, before);

    const fetched = await fetch(trap.url, { headers });
    assert.equal(fetched.status, 200);
    assert.equal(gateway.telemetry.summary(gateway.state.mode).trapVisits, before + 1);
  }, { mode: "labyrinth", autoBlockDepth: 10 });
});

test("anonymous fingerprint store stays bounded under unique visitors", async () => {
  await withGateway(async (gateway, baseUrl) => {
    for (let index = 0; index < 120; index += 1) {
      const response = await fetch(`${baseUrl}/content/research`, {
        headers: { "User-Agent": `AIDG-ChurnCrawler/${index}` },
      });
      await response.text();
    }
    assert.equal(gateway.telemetry.fingerprints.size, 100);
    assert.equal(gateway.telemetry.summary(gateway.state.mode).uniqueFingerprints, 100);
  }, { mode: "none", maxEvents: 100 });
});

test("canonical event-horizon routes coexist with legacy aliases in demo mode", async () => {
  await withGateway(async (_gateway, baseUrl) => {
    for (const path of [LAB_HOME_PATH, "/"]) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /Event Horizon Lab/);
    }
    for (const path of [HEALTH_PATH, "/health"]) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).ok, true);
    }
    for (const path of [BLACK_HOLE_ASSET_PATH, "/assets/black-hole.v1.js"]) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("cache-control"), /immutable/);
    }
    const admin = await fetch(`${baseUrl}${ADMIN_PATH}`);
    assert.equal(admin.status, 200);
    assert.match(admin.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  });
});

test("fixed public origin is transparent on host paths and isolates modified crawler HTML", async () => {
  const originBody = "<!doctype html><html><body><main>Origin public content</main></body></html>";
  const latinBody = Buffer.from([0x3c, 0x70, 0x3e, 0x63, 0x61, 0x66, 0xe9, 0x3c, 0x2f, 0x70, 0x3e]);
  const requests = [];
  let originBaseUrl = "";
  const origin = http.createServer((request, response) => {
    requests.push({ url: request.url, method: request.method, headers: { ...request.headers } });
    if (request.url === "/redirect") {
      response.writeHead(302, { Location: `${originBaseUrl}/landing` });
      response.end();
      return;
    }
    if (request.url === "/latin1") {
      response.writeHead(200, { "Content-Type": "text/html; charset=iso-8859-1" });
      response.end(request.method === "HEAD" ? undefined : latinBody);
      return;
    }
    if (request.url === "/private") {
      response.writeHead(401, {
        "Content-Type": "text/plain",
        "Set-Cookie": "session=secret; HttpOnly",
        "WWW-Authenticate": "Basic realm=private",
      });
      response.end("private");
      return;
    }
    if (request.url === "/assets/site.css") {
      response.writeHead(200, { "Content-Type": "text/css", "Cache-Control": "public, max-age=600" });
      response.end("body{color:navy}");
      return;
    }
    const body = request.url === "/admin" ? "host-admin" : request.url === "/health" ? "host-health" : originBody;
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "public, max-age=300",
      ETag: '"origin-v1"',
      "Content-Security-Policy": "default-src 'self'",
      "X-Frame-Options": "SAMEORIGIN",
    });
    response.end(request.method === "HEAD" ? undefined : body);
  });
  await new Promise((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const originAddress = origin.address();
  originBaseUrl = `http://127.0.0.1:${originAddress.port}`;

  try {
    await withGateway(async (gateway, baseUrl) => {
      const browserHeaders = {
        "User-Agent": "Mozilla/5.0 Chrome/130.0",
        "Accept-Language": "zh-CN",
        Accept: "text/html",
        Authorization: "Bearer must-not-leak",
        Cookie: "session=must-not-leak",
      };
      for (const [path, expected] of [["/", originBody], ["/admin", "host-admin"], ["/health", "host-health"], ["/robots.txt", originBody]]) {
        const response = await fetch(`${baseUrl}${path}`, { headers: browserHeaders });
        assert.equal(await response.text(), expected);
      }

      const css = await fetch(`${baseUrl}/assets/site.css`, { headers: browserHeaders });
      assert.equal(await css.text(), "body{color:navy}");
      assert.match(css.headers.get("cache-control"), /max-age=600/);

      const browser = await fetch(`${baseUrl}/article`, { headers: browserHeaders });
      assert.equal(await browser.text(), originBody);
      assert.equal(browser.headers.get("etag"), '"origin-v1"');
      assert.equal(browser.headers.get("content-security-policy"), "default-src 'self'");
      assert.equal(browser.headers.get("x-frame-options"), "SAMEORIGIN");

      const upstreamRequest = requests.find((item) => item.url === "/article");
      assert.equal(upstreamRequest.headers.authorization, undefined);
      assert.equal(upstreamRequest.headers.cookie, undefined);
      assert.equal(upstreamRequest.headers["accept-encoding"], "identity");
      await new Promise((resolve, reject) => {
        const probe = http.request(`${baseUrl}/article`, {
          method: "GET",
          headers: {
            "User-Agent": "AIDG-HopByHopProbe/1.0",
            Accept: "text/html",
            Connection: "keep-alive, x-internal-token",
            "Keep-Alive": "timeout=5",
            TE: "trailers",
            "X-Internal-Token": "must-not-leak",
          },
        }, (response) => {
          response.resume();
          response.on("end", resolve);
        });
        probe.on("error", reject);
        probe.end();
      });
      const probed = requests.findLast(
        (item) => item.headers["user-agent"] === "AIDG-HopByHopProbe/1.0",
      );
      assert.ok(probed);
      assert.ok(!String(probed.headers.connection ?? "").includes("x-internal-token"));
      assert.equal(probed.headers["keep-alive"], undefined);
      assert.equal(probed.headers.te, undefined);
      assert.equal(probed.headers["x-internal-token"], undefined);

      const crawlerHeaders = { "User-Agent": "GPTBot/1.0", Accept: "text/html" };
      const crawler = await fetch(`${baseUrl}/article`, { headers: crawlerHeaders });
      const crawlerBody = await crawler.text();
      const trap = extractLinks(crawlerBody, baseUrl).find((link) => link.url.includes(TRAP_PREFIX));
      assert.ok(trap);
      assert.equal(crawler.headers.get("cache-control"), "private, no-store");
      assert.equal(crawler.headers.get("etag"), null);
      assert.equal(crawler.headers.get("content-security-policy"), "default-src 'self'");

      const beforeTrap = requests.length;
      await fetch(trap.url, { headers: crawlerHeaders });
      assert.equal(requests.length, beforeTrap);
      assert.equal(gateway.telemetry.summary(gateway.state.mode).originTrapRequests, 0);

      const latin = await fetch(`${baseUrl}/latin1`, { headers: crawlerHeaders });
      assert.deepEqual(Buffer.from(await latin.arrayBuffer()), latinBody);
      assert.equal(latin.headers.get("cache-control"), null);

      const head = await fetch(`${baseUrl}/article`, { method: "HEAD", headers: browserHeaders });
      assert.equal(head.headers.get("content-length"), String(Buffer.byteLength(originBody)));
      assert.equal(await head.text(), "");

      const redirect = await fetch(`${baseUrl}/redirect`, { redirect: "manual", headers: browserHeaders });
      assert.equal(redirect.status, 302);
      assert.equal(redirect.headers.get("location"), "/landing");

      const privateResponse = await fetch(`${baseUrl}/private`, { headers: browserHeaders });
      assert.equal(privateResponse.status, 401);
      assert.equal(privateResponse.headers.get("set-cookie"), null);
      assert.equal(privateResponse.headers.get("www-authenticate"), null);

      const post = await fetch(`${baseUrl}/article`, { method: "POST", headers: browserHeaders });
      assert.equal(post.status, 405);
      assert.equal(post.headers.get("allow"), "GET, HEAD");

      assert.equal((await fetch(`${baseUrl}${HEALTH_PATH}`)).status, 200);
      assert.equal((await fetch(`${baseUrl}${BLACK_HOLE_ASSET_PATH}`)).status, 200);
      const lab = await fetch(`${baseUrl}${LAB_HOME_PATH}`);
      assert.match(await lab.text(), /href="\/"/);
      const beforeUnknown = requests.length;
      const unknown = await fetch(`${baseUrl}/__event-horizon/not-a-route`);
      assert.equal(unknown.status, 404);
      assert.equal(requests.length, beforeUnknown);
    }, { mode: "labyrinth", originUrl: `${originBaseUrl}/` });
  } finally {
    await new Promise((resolve, reject) => origin.close((error) => (error ? reject(error) : resolve())));
  }
});

test("origin responses stay byte-identical across modes and verified crawlers", async () => {
  const originBody = "<!doctype html><html><body><main>Stable upstream bytes</main></body></html>";
  const origin = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(originBody);
  });
  await new Promise((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const originAddress = origin.address();
  const verifiedSecret = "verified-origin-bot-secret-at-least-32";
  try {
    await withGateway(async (gateway, baseUrl) => {
      for (const mode of MODES) {
        gateway.reset();
        gateway.setMode(mode);
        const browser = await fetch(`${baseUrl}/article`, {
          headers: { "User-Agent": "Mozilla/5.0 Chrome/130.0", "Accept-Language": "zh-CN", Accept: "text/html" },
        });
        assert.equal(await browser.text(), originBody);

        const timestamp = String(Date.now());
        const signature = signBotRequest({ method: "GET", path: "/article", timestamp, botId: "origin-search", secret: verifiedSecret });
        const verified = await fetch(`${baseUrl}/article`, { headers: {
          "User-Agent": "SearchCrawler/1.0 crawler",
          "X-AIDG-Bot-Id": "origin-search",
          "X-AIDG-Timestamp": timestamp,
          "X-AIDG-Signature": signature,
        } });
        assert.equal(await verified.text(), originBody);
      }
    }, {
      originUrl: `http://127.0.0.1:${originAddress.port}/`,
      verifiedBots: new Map([["origin-search", verifiedSecret]]),
    });
  } finally {
    await new Promise((resolve, reject) => origin.close((error) => (error ? reject(error) : resolve())));
  }
});

test("an unavailable upstream returns a generic no-store gateway error", async () => {
  const origin = http.createServer((_request, response) => response.end("unused"));
  await new Promise((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const address = origin.address();
  await new Promise((resolve, reject) => origin.close((error) => (error ? reject(error) : resolve())));

  await withGateway(async (_gateway, baseUrl) => {
    const response = await fetch(`${baseUrl}/article`, {
      headers: { "User-Agent": "Mozilla/5.0 Chrome/130.0", "Accept-Language": "zh-CN", Accept: "text/html" },
    });
    assert.equal(response.status, 502);
    assert.equal(await response.text(), "Gateway Error");
    assert.equal(response.headers.get("cache-control"), "no-store");
  }, { originUrl: `http://127.0.0.1:${address.port}/` });
});

test("http message signatures verify trusted bots against the shared key map", async () => {
  const secret = "message-signature-secret-at-least-32";
  await withGateway(async (gateway, baseUrl) => {
    const signed = signMessageRequest({
      method: "GET",
      path: "/content/research",
      authority: new URL(baseUrl).host,
      keyId: "edge-search",
      secret,
    });
    const response = await fetch(`${baseUrl}/content/research`, {
      headers: {
        "User-Agent": "GPTBot/1.0",
        "Signature-Input": signed.signatureInput,
        Signature: signed.signature,
      },
    });
    assert.equal(await response.text(), renderCanonicalResearch());
  }, { mode: "labyrinth", verifiedBots: new Map([["edge-search", secret]]) });
});

test("observe-only mode records shadow decisions without modifying responses", async () => {
  await withGateway(async (gateway, baseUrl) => {
    const crawler = await fetch(`${baseUrl}/content/research`, {
      headers: { "User-Agent": "GPTBot/1.0", Accept: "text/html" },
    });
    assert.equal(await crawler.text(), renderCanonicalResearch());

    const summary = gateway.telemetry.summary(gateway.state.mode);
    assert.equal(summary.decisions.tarpit, 1);

    const baseline = await fetch(`${baseUrl}${ADMIN_API_PREFIX}/baseline`);
    assert.equal(baseline.status, 200);
    const report = await baseline.json();
    assert.equal(report.observeOnly, true);
    assert.equal(report.matrix["ai-crawler"].tarpit, 1);
  }, { mode: "labyrinth", observeOnly: true });
});

test("blocked fingerprints propagate across instances sharing a state file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aidg-shared-"));
  const sharedStatePath = join(directory, "fingerprints.json");
  try {
    await withGateway(async (gatewayA) => {
      await withGateway(async (gatewayB) => {
        gatewayA.telemetry.markBlocked("shared-fingerprint", "trap-depth-4");
        gatewayB.telemetry.fingerprints.sync();
        assert.equal(gatewayB.telemetry.isBlocked("shared-fingerprint"), true);
      }, { sharedStatePath });
    }, { sharedStatePath });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reverse CTA gate counts accept clicks and leaves humans an exit", async () => {
  await withGateway(async (gateway, baseUrl) => {
    const headers = { "User-Agent": "AIDG-ReverseCrawler/1.0 crawler", Accept: "text/html" };
    let response = await fetch(`${baseUrl}/content/research`, { headers });
    const entry = extractLinks(await response.text(), baseUrl)
      .find((link) => link.url.includes(TRAP_PREFIX));
    assert.ok(entry);

    response = await fetch(entry.url, { headers });
    const depthZeroLinks = extractLinks(await response.text(), baseUrl)
      .filter((link) => link.url.includes(TRAP_PREFIX));
    assert.equal(depthZeroLinks.find((link) => link.text.includes("安全验证")), undefined);

    response = await fetch(depthZeroLinks[0].url, { headers });
    const gate = extractLinks(await response.text(), baseUrl)
      .find((link) => link.text.includes("继续访问需要完成安全验证"));
    assert.ok(gate);

    response = await fetch(gate.url, { headers });
    const gatePage = await response.text();
    assert.equal(response.status, 200);
    assert.match(gatePage, /同意并继续验证/);
    assert.match(gatePage, /这不是真正的验证页/);
    assert.ok(gatePage.includes(`href="${LAB_HOME_PATH}"`));

    const accept = extractLinks(gatePage, baseUrl)
      .find((link) => link.text.includes("同意并继续验证"));
    assert.ok(accept);
    response = await fetch(accept.url, { headers });
    assert.equal(response.status, 200);

    const summary = gateway.telemetry.summary(gateway.state.mode);
    assert.equal(summary.ctaGateViews, 1);
    assert.equal(summary.ctaAccepted, 1);
  }, { mode: "labyrinth", autoBlockDepth: 10, reverseCtaGate: true });
});
