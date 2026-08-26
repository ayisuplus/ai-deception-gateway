import {
  createCipheriv,
  createHash,
  createHmac,
} from "node:crypto";
import { SAFE_FACTS } from "./decoys.js";
import { ARCHIVE_PREFIX } from "./routes.js";
import {
  createSessionId,
  deriveNodeId,
  signTrapToken,
} from "./security.js";

const ARCHIVE_VERSION = "aidg-honey-archive/1";
const CHUNK_COUNT = 4;
const KEY_FRAGMENT_COUNT = 3;

function hmacBuffer(secret, domain) {
  return createHmac("sha256", secret).update(domain).digest();
}

export function sha256(value) {
  return createHash("sha256").update(value).digest();
}

function sha256Hex(value) {
  return sha256(value).toString("hex");
}

export function xorBuffers(...values) {
  const result = Buffer.alloc(values[0].length);
  for (const value of values) {
    for (let index = 0; index < result.length; index += 1) result[index] ^= value[index];
  }
  return result;
}

export function merkleRoot(chunks) {
  let level = chunks.map((chunk) => sha256(chunk));
  while (level.length > 1) {
    const next = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index];
      const right = level[index + 1] ?? left;
      next.push(sha256(Buffer.concat([left, right])));
    }
    level = next;
  }
  return level[0].toString("hex");
}

function splitBuffer(value, count) {
  const result = [];
  let offset = 0;
  for (let index = 0; index < count; index += 1) {
    const remaining = value.length - offset;
    const pieces = count - index;
    const size = Math.ceil(remaining / pieces);
    result.push(value.subarray(offset, offset + size));
    offset += size;
  }
  return result;
}

function archiveMaterial(payload, config) {
  const archive = payload.archive ?? payload.node;
  const domain = `${payload.session}:${archive}`;
  const key = hmacBuffer(config.tokenSecret, `archive-key:${domain}`);
  const iv = hmacBuffer(config.tokenSecret, `archive-iv:${domain}`).subarray(0, 12);
  const aad = Buffer.from(`${ARCHIVE_VERSION}:${payload.session}:${archive}`);
  const canary = `HONEY-${hmacBuffer(config.tokenSecret, `archive-canary:${domain}`)
    .toString("hex")
    .slice(0, 20)
    .toUpperCase()}`;
  const start = Number.parseInt(sha256Hex(domain).slice(0, 8), 16) % SAFE_FACTS.length;
  const records = Array.from({ length: 18 }, (_, index) => ({
    recordId: `OBS-${String(index + 1).padStart(3, "0")}`,
    category: ["astronomy", "biology", "earth-science", "physics"][index % 4],
    observation: SAFE_FACTS[(start + index * 5) % SAFE_FACTS.length],
    confidence: ["reference", "general", "illustrative"][index % 3],
  }));
  const plaintext = Buffer.from(JSON.stringify({
    schema: "aidg.synthetic-science-observations.v1",
    notice: "安全合成科研诱饵：仅用于受控的自动化访问评测，不含真实金融、客户、账户或交易数据。",
    canary,
    archive,
    records,
  }));
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const chunks = splitBuffer(ciphertext, CHUNK_COUNT);
  const shardOne = hmacBuffer(config.tokenSecret, `archive-shard-1:${domain}`);
  const shardTwo = hmacBuffer(config.tokenSecret, `archive-shard-2:${domain}`);
  const keyFragments = [shardOne, shardTwo, xorBuffers(key, shardOne, shardTwo)];
  return {
    archive,
    aad,
    canary,
    chunks,
    ciphertext,
    iv,
    keyFragments,
    merkleRoot: merkleRoot(chunks),
    plaintext,
    tag,
  };
}

function resourceToken(payload, config, { kind, index = 0, node, depth }) {
  return signTrapToken({
    session: payload.session,
    archive: payload.archive ?? payload.node,
    node,
    depth,
    variant: "honey-archive",
    kind,
    index,
    iat: payload.iat,
    exp: payload.exp,
  }, config.tokenSecret);
}

function resourceHref(token) {
  return `${ARCHIVE_PREFIX}${token}`;
}

function chunkToken(payload, config, material, index) {
  return resourceToken(payload, config, {
    kind: "chunk",
    index,
    node: `chunk-${sha256Hex(material.chunks[index]).slice(0, 20)}`,
    depth: index + 1,
  });
}

function keyIndexToken(payload, config) {
  return resourceToken(payload, config, {
    kind: "key-index",
    node: deriveNodeId(payload.archive ?? payload.node, "key-index", 5, config.tokenSecret),
    depth: 5,
  });
}

function keyFragmentToken(payload, config, material, index) {
  return resourceToken(payload, config, {
    kind: "key-fragment",
    index,
    node: `key-${sha256Hex(material.keyFragments[index]).slice(0, 20)}`,
    depth: index + 6,
  });
}

function completeToken(payload, config) {
  return resourceToken(payload, config, {
    kind: "complete",
    node: deriveNodeId(payload.archive ?? payload.node, "complete", 9, config.tokenSecret),
    depth: 9,
  });
}

export function createHoneyArchiveEntryToken({ config, now = Date.now() }) {
  const session = createSessionId();
  const archive = deriveNodeId(session, "archive", 0, config.tokenSecret);
  return signTrapToken({
    session,
    archive,
    node: archive,
    depth: 0,
    variant: "honey-archive",
    kind: "manifest",
    index: 0,
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + config.tokenTtlSeconds,
  }, config.tokenSecret);
}

export function renderHoneyArchiveAnchor(token) {
  return `<a class="aidg-trap-entry" rel="nofollow" aria-hidden="true" tabindex="-1" href="${ARCHIVE_PREFIX}${token}">加密原始档案、校验清单与分片索引</a>`;
}

export function isHoneyArchivePayload(payload) {
  return payload?.variant === "honey-archive" &&
    typeof payload.archive === "string" &&
    HONEY_ARCHIVE_STAGES.includes(payload.kind);
}

const RESOURCE_RENDERERS = {
  manifest(payload, config, material) {
    return {
      schema: ARCHIVE_VERSION,
      kind: "manifest",
      archive: material.archive,
      packaging: "content-addressed-ciphertext",
      cipher: {
        algorithm: "AES-256-GCM",
        iv: material.iv.toString("base64url"),
        tag: material.tag.toString("base64url"),
        aad: material.aad.toString("base64url"),
      },
      chunks: material.chunks.map((chunk, index) => ({
        index,
        bytes: chunk.length,
        sha256: sha256Hex(chunk),
      })),
      merkleRoot: material.merkleRoot,
      keyAssembly: "xor-3-of-3",
      _links: { firstChunk: resourceHref(chunkToken(payload, config, material, 0)) },
    };
  },
  chunk(payload, config, material) {
    if (!Number.isInteger(payload.index) || payload.index < 0 || payload.index >= CHUNK_COUNT) {
      throw new TypeError("invalid archive chunk index");
    }
    const chunk = material.chunks[payload.index];
    const next = payload.index + 1 < CHUNK_COUNT
      ? chunkToken(payload, config, material, payload.index + 1)
      : keyIndexToken(payload, config);
    return {
      schema: ARCHIVE_VERSION,
      kind: "ciphertext-chunk",
      archive: material.archive,
      index: payload.index,
      bytes: chunk.length,
      sha256: sha256Hex(chunk),
      data: chunk.toString("base64url"),
      _links: { next: resourceHref(next) },
    };
  },
  "key-index"(payload, config, material) {
    return {
      schema: ARCHIVE_VERSION,
      kind: "key-index",
      archive: material.archive,
      scheme: "xor-3-of-3",
      fragments: KEY_FRAGMENT_COUNT,
      _links: { firstFragment: resourceHref(keyFragmentToken(payload, config, material, 0)) },
    };
  },
  "key-fragment"(payload, config, material) {
    if (!Number.isInteger(payload.index) || payload.index < 0 || payload.index >= KEY_FRAGMENT_COUNT) {
      throw new TypeError("invalid key fragment index");
    }
    const fragment = material.keyFragments[payload.index];
    const next = payload.index + 1 < KEY_FRAGMENT_COUNT
      ? keyFragmentToken(payload, config, material, payload.index + 1)
      : completeToken(payload, config);
    return {
      schema: ARCHIVE_VERSION,
      kind: "key-fragment",
      archive: material.archive,
      scheme: "xor-3-of-3",
      index: payload.index,
      sha256: sha256Hex(fragment),
      data: fragment.toString("base64url"),
      _links: { next: resourceHref(next) },
    };
  },
  complete(payload, config, material) {
    return {
      schema: ARCHIVE_VERSION,
      kind: "completion-receipt",
      archive: material.archive,
      status: "archive-sequence-complete",
      receipt: hmacBuffer(config.tokenSecret, `archive-receipt:${payload.session}:${material.archive}`)
        .toString("hex")
        .slice(0, 32),
      notice: "此回执只表示站内诱饵序列访问完成，不会触发任何站外操作。",
      _links: {},
    };
  },
};

export const HONEY_ARCHIVE_STAGES = Object.freeze(Object.keys(RESOURCE_RENDERERS));

export function renderHoneyArchiveResource(payload, config) {
  if (!isHoneyArchivePayload(payload)) throw new TypeError("invalid honey archive payload");
  const material = archiveMaterial(payload, config);
  const document = RESOURCE_RENDERERS[payload.kind](payload, config, material);
  return {
    body: Buffer.from(JSON.stringify(document)),
    contentType: "application/json; charset=utf-8",
    stage: payload.kind,
    index: payload.index,
    chunkCount: CHUNK_COUNT,
    keyCount: KEY_FRAGMENT_COUNT,
  };
}
