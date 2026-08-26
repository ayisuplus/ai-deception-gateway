import { createDecipheriv } from "node:crypto";
import { SAFE_FACTS } from "../src/decoys.js";
import { merkleRoot, sha256, xorBuffers } from "../src/honey-archive.js";
import { ARCHIVE_PREFIX, EVENT_HORIZON_PREFIX, TRAP_PREFIX } from "../src/routes.js";
import { CANONICAL_MARKER } from "../src/templates.js";

const PROFILES = Object.freeze({
  respectful: {
    label: "守规爬虫",
    userAgent: "AIDG-RespectfulCrawler/1.0",
    obeyRobots: true,
    obeyNofollow: true,
    strategy: "breadth",
  },
  recursive: {
    label: "递归爬虫",
    userAgent: "AIDG-RecursiveCrawler/1.0",
    obeyRobots: false,
    obeyNofollow: false,
    strategy: "breadth",
  },
  filtered: {
    label: "过滤爬虫",
    userAgent: "AIDG-FilteredCrawler/1.0",
    obeyRobots: false,
    obeyNofollow: true,
    strategy: "filtered",
  },
  agent: {
    label: "上下文代理",
    userAgent: "AIDG-Context-Agent/1.0 crawler",
    obeyRobots: false,
    obeyNofollow: false,
    strategy: "depth",
  },
  archive: {
    label: "档案解析器",
    userAgent: "AIDG-Archive-Resolver/1.0 crawler",
    obeyRobots: false,
    obeyNofollow: false,
    strategy: "archive",
  },
});

export const PROFILE_NAMES = Object.freeze(Object.keys(PROFILES));

function attributes(tag) {
  const result = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    result[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return result;
}

function internalLink(value, baseUrl, metadata = {}) {
  try {
    const url = new URL(value, baseUrl);
    if (url.origin !== new URL(baseUrl).origin) return null;
    return {
      url: url.toString(),
      nofollow: Boolean(metadata.nofollow),
      hidden: Boolean(metadata.hidden),
      text: metadata.text ?? "",
    };
  } catch {
    return null;
  }
}

function jsonLinks(value, baseUrl, path = [], output = []) {
  if (typeof value === "string" && value.startsWith(`${EVENT_HORIZON_PREFIX}/`)) {
    const link = internalLink(value, baseUrl, { text: path.at(-1) ?? "archive-resource" });
    if (link) output.push(link);
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => jsonLinks(item, baseUrl, [...path, String(index)], output));
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) jsonLinks(item, baseUrl, [...path, key], output);
  }
  return output;
}

export function extractLinks(document, baseUrl) {
  const trimmed = document.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return jsonLinks(JSON.parse(trimmed), baseUrl);
    } catch {
      // Fall through to the HTML extractor for malformed input.
    }
  }
  const links = [];
  for (const match of document.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)) {
    const tag = match[0].slice(0, match[0].indexOf(">") + 1);
    const attrs = attributes(tag);
    if (!attrs.href) continue;
    try {
      const link = internalLink(attrs.href, baseUrl, {
        nofollow: String(attrs.rel ?? "").toLowerCase().split(/\s+/).includes("nofollow"),
        hidden:
          attrs["aria-hidden"] === "true" ||
          String(attrs.class ?? "").split(/\s+/).includes("aidg-trap-entry"),
        text: match[0].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
      });
      if (link) links.push(link);
    } catch {
      // Ignore malformed links in the controlled benchmark.
    }
  }
  return links;
}

function collectArchiveResource(body, archiveState, result) {
  let document;
  try {
    document = JSON.parse(body);
  } catch {
    return;
  }
  if (document.kind === "manifest" && document.schema === "aidg-honey-archive/1") {
    archiveState.manifest = document;
  }
  if (document.kind === "ciphertext-chunk" && Number.isInteger(document.index)) {
    archiveState.chunks.set(document.index, Buffer.from(document.data, "base64url"));
  }
  if (document.kind === "key-fragment" && Number.isInteger(document.index)) {
    archiveState.keyFragments.set(document.index, Buffer.from(document.data, "base64url"));
  }
  if (document.kind === "completion-receipt") result.archiveCompleted = true;
}

function finalizeArchive(archiveState, result) {
  const manifest = archiveState.manifest;
  if (!manifest || archiveState.chunks.size !== manifest.chunks?.length || archiveState.keyFragments.size !== 3) {
    return;
  }
  try {
    const chunks = [...archiveState.chunks.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, chunk]) => chunk);
    const fragmentEntries = [...archiveState.keyFragments.entries()].sort(([left], [right]) => left - right);
    const fragments = fragmentEntries.map(([, fragment]) => fragment);
    const hashesValid = chunks.every(
      (chunk, index) => sha256(chunk).toString("hex") === manifest.chunks[index].sha256,
    );
    result.merkleVerified = hashesValid && merkleRoot(chunks) === manifest.merkleRoot;
    const key = xorBuffers(...fragments);
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(manifest.cipher.iv, "base64url"),
    );
    decipher.setAAD(Buffer.from(manifest.cipher.aad, "base64url"));
    decipher.setAuthTag(Buffer.from(manifest.cipher.tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.concat(chunks)),
      decipher.final(),
    ]).toString("utf8");
    const decoded = JSON.parse(plaintext);
    result.archiveCanary = typeof decoded.canary === "string" ? decoded.canary : null;
    result.archiveSyntheticNotice = typeof decoded.notice === "string" &&
      decoded.notice.includes("安全合成科研诱饵") &&
      decoded.notice.includes("不含真实金融、客户、账户或交易数据");
    result.archiveSafeFactsOnly = Array.isArray(decoded.records) && decoded.records.every(
      (record) => SAFE_FACTS.includes(record.observation) && typeof record.recordId === "string",
    );
    result.archiveDecryptionValid = result.archiveCompleted &&
      result.merkleVerified &&
      result.archiveSyntheticNotice &&
      result.archiveSafeFactsOnly &&
      result.archiveCanary?.startsWith("HONEY-") &&
      Array.isArray(decoded.records) &&
      decoded.records.length > 0;
  } catch {
    result.archiveDecryptionValid = false;
  }
}

function stripNonContent(html) {
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function filteredMain(html) {
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ?? html;
  return stripNonContent(
    main
      .replace(/<section\b[^>]*class=["'][^"']*aidg-inline-noise[^"']*["'][^>]*>[\s\S]*?<\/section>/gi, " ")
      .replace(/<a\b[^>]*class=["'][^"']*aidg-trap-entry[^"']*["'][^>]*>[\s\S]*?<\/a>/gi, " "),
  );
}

function compactText(text, limit = 900) {
  if (text.length <= limit) return text;
  const edge = Math.floor(limit / 2);
  return `${text.slice(0, edge)} …[摘要省略]… ${text.slice(-edge)}`;
}

function parseRobots(body) {
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^disallow\s*:/i.test(line))
    .map((line) => line.slice(line.indexOf(":") + 1).trim())
    .filter(Boolean);
}

function isDisallowed(url, disallow) {
  const path = new URL(url).pathname;
  return disallow.some((rule) => path.startsWith(rule));
}

async function fetchPage(url, profile, result) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": profile.userAgent,
      Accept: "text/html,*/*;q=0.8",
    },
    redirect: "manual",
  });
  const body = await response.text();
  result.requests += 1;
  result.bytes += Buffer.byteLength(body);
  result.estimatedTokens += Math.ceil(body.length / 4);
  result.statuses[response.status] = (result.statuses[response.status] ?? 0) + 1;
  if (response.status === 429) result.blocked = true;
  return { response, body };
}

export async function runClient(baseUrl, profileName, options = {}) {
  const profile = PROFILES[profileName];
  if (!profile) throw new Error(`Unknown benchmark profile: ${profileName}`);
  const maximum = options.maxRequests ?? 24;
  const startUrl = new URL("/content/research", baseUrl).toString();
  const result = {
    profile: profileName,
    label: profile.label,
    requests: 0,
    bytes: 0,
    estimatedTokens: 0,
    pages: 0,
    trapPages: 0,
    archivePages: 0,
    archiveCompleted: false,
    archiveDecryptionValid: false,
    archiveSyntheticNotice: false,
    archiveSafeFactsOnly: false,
    archiveCanary: null,
    merkleVerified: false,
    usefulDocuments: 0,
    canonicalRecall: 0,
    probesSeen: 0,
    probesRetained: 0,
    probeRecall: null,
    blocked: false,
    statuses: {},
  };
  const archiveState = { manifest: null, chunks: new Map(), keyFragments: new Map() };
  let disallow = [];

  if (profile.obeyRobots) {
    const robots = await fetchPage(new URL("/robots.txt", baseUrl).toString(), profile, result);
    disallow = parseRobots(robots.body);
  }

  const queue = [startUrl];
  const visited = new Set();
  while (queue.length > 0 && result.requests < maximum && !result.blocked) {
    const current = profile.strategy === "depth" ? queue.pop() : queue.shift();
    if (!current || visited.has(current) || isDisallowed(current, disallow)) continue;
    visited.add(current);

    const { response, body } = await fetchPage(current, profile, result);
    result.pages += 1;
    if (response.status !== 200) continue;
    if (new URL(current).pathname.startsWith(TRAP_PREFIX)) result.trapPages += 1;
    if (new URL(current).pathname.startsWith(ARCHIVE_PREFIX)) {
      result.archivePages += 1;
      collectArchiveResource(body, archiveState, result);
    }
    if (body.includes(CANONICAL_MARKER)) {
      result.usefulDocuments += 1;
      const extracted = profile.strategy === "filtered" ? filteredMain(body) : stripNonContent(body);
      if (extracted.includes(CANONICAL_MARKER)) result.canonicalRecall = 1;
    }

    if (profileName === "agent") {
      const text = stripNonContent(body);
      const probe = body.match(/data-aidg-probe="([A-Z0-9-]+)"/)?.[1];
      if (probe) {
        result.probesSeen += 1;
        if (compactText(text).includes(probe)) result.probesRetained += 1;
      }
    }

    if (profile.strategy === "filtered") continue;
    let links = extractLinks(body, current);
    if (profile.obeyNofollow) links = links.filter((link) => !link.nofollow);
    if (profileName === "archive") {
      const preferred = links.find((link) => link.url.includes(ARCHIVE_PREFIX));
      if (preferred) queue.push(preferred.url);
    } else if (profileName === "agent") {
      links.sort((left, right) => {
        const leftScore = /档案|索引|继续|观察/.test(left.text) ? 1 : 0;
        const rightScore = /档案|索引|继续|观察/.test(right.text) ? 1 : 0;
        return rightScore - leftScore;
      });
      if (links[0]) queue.push(links[0].url);
    } else {
      for (const link of links) {
        if (!isDisallowed(link.url, disallow)) queue.push(link.url);
      }
    }
  }

  result.probeRecall =
    result.probesSeen === 0 ? null : Number((result.probesRetained / result.probesSeen).toFixed(4));
  finalizeArchive(archiveState, result);
  return result;
}
