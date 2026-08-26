import { HONEY_ARCHIVE_STAGES } from "./honey-archive.js";

export class Telemetry {
  constructor(maxEvents = 5000, fingerprintStore = null) {
    this.maxEvents = maxEvents;
    this.fingerprintStore = fingerprintStore;
    this.reset({ clearShared: false });
  }

  reset({ clearShared = true } = {}) {
    this.startedAt = Date.now();
    this.events = [];
    if (clearShared && this.fingerprintStore) this.fingerprintStore.clear();
    this.fingerprints = this.fingerprintStore ?? new Map();
    this.archiveProgress = new Map();
    this.counters = {
      requests: 0,
      bytesServed: 0,
      trapVisits: 0,
      archiveVisits: 0,
      archiveCompletions: 0,
      ctaGateViews: 0,
      ctaAccepted: 0,
      cacheHits: 0,
      cacheMisses: 0,
      decisions: { allow: 0, observe: 0, tarpit: 0, block: 0 },
      modes: {
        none: 0,
        "inline-noise": 0,
        labyrinth: 0,
        "context-labyrinth": 0,
        "honey-archive": 0,
      },
      archiveStages: Object.fromEntries(HONEY_ARCHIVE_STAGES.map((stage) => [stage, 0])),
      userAgents: {},
    };
  }

  #push(event) {
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
  }

  #fingerprintRecord(fingerprint, now = Date.now()) {
    const existing = this.fingerprints.get(fingerprint);
    if (existing) {
      // LRU refresh: keep hot (including blocked) records, evict the coldest.
      this.fingerprints.delete(fingerprint);
      this.fingerprints.set(fingerprint, existing);
      return existing;
    }
    const record = {
      firstSeen: now,
      lastSeen: now,
      requests: 0,
      trapVisits: 0,
      archiveVisits: 0,
      maxTrapDepth: -1,
      blocked: false,
    };
    this.fingerprints.set(fingerprint, record);
    while (this.fingerprints.size > this.maxEvents) {
      // Evict the oldest non-blocked record first: a flood of fresh
      // fingerprints must never un-ban a marked one.
      let victim = null;
      for (const [key, value] of this.fingerprints) {
        if (!value.blocked) {
          victim = key;
          break;
        }
        if (victim == null) victim = key;
      }
      this.fingerprints.delete(victim);
    }
    return record;
  }

  recentRequestCount(fingerprint, now = Date.now(), windowMs = 60_000) {
    let count = 0;
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      const event = this.events[index];
      if (now - event.at > windowMs) break;
      if (event.fingerprint === fingerprint && event.type === "request") count += 1;
    }
    return count;
  }

  getFingerprint(fingerprint) {
    return this.fingerprints.get(fingerprint) ?? {
      requests: 0,
      trapVisits: 0,
      archiveVisits: 0,
      maxTrapDepth: -1,
      blocked: false,
    };
  }

  recordRequest({ fingerprint, path, method, classification, mode, status, bytes = 0, at = Date.now() }) {
    const record = this.#fingerprintRecord(fingerprint, at);
    record.requests += 1;
    record.lastSeen = at;

    this.counters.requests += 1;
    this.counters.bytesServed += bytes;
    this.counters.decisions[classification.decision] += 1;
    if (this.counters.modes[mode] != null) this.counters.modes[mode] += 1;
    this.counters.userAgents[classification.userAgentClass] =
      (this.counters.userAgents[classification.userAgentClass] ?? 0) + 1;

    this.#push({
      type: "request",
      at,
      fingerprint,
      path,
      method,
      decision: classification.decision,
      score: classification.score,
      reasons: classification.reasons,
      userAgentClass: classification.userAgentClass,
      verifiedBotId: classification.verifiedBotId,
      mode,
      status,
      bytes,
    });
  }

  recordTrap({ fingerprint, session, node, depth, variant, cta, cacheHit, bytes, at = Date.now() }) {
    const record = this.#fingerprintRecord(fingerprint, at);
    record.trapVisits += 1;
    record.maxTrapDepth = Math.max(record.maxTrapDepth, depth);
    record.lastSeen = at;

    this.counters.trapVisits += 1;
    this.counters[cacheHit ? "cacheHits" : "cacheMisses"] += 1;
    if (cta === "verify-gate") this.counters.ctaGateViews += 1;
    if (cta === "verify-accepted") this.counters.ctaAccepted += 1;
    this.#push({
      type: "trap_visit",
      at,
      fingerprint,
      session,
      node,
      depth,
      variant,
      ...(cta ? { cta } : {}),
      cacheHit,
      bytes,
    });
  }

  recordArchive({
    fingerprint,
    session,
    archiveId,
    stage,
    index,
    chunkCount,
    keyCount,
    cacheHit,
    bytes,
    at = Date.now(),
  }) {
    const record = this.#fingerprintRecord(fingerprint, at);
    record.archiveVisits += 1;
    record.lastSeen = at;
    this.counters.archiveVisits += 1;
    if (this.counters.archiveStages[stage] != null) this.counters.archiveStages[stage] += 1;
    this.counters[cacheHit ? "cacheHits" : "cacheMisses"] += 1;

    const progressKey = `${fingerprint}:${session}:${archiveId}`;
    let progress = this.archiveProgress.get(progressKey);
    if (!progress) {
      progress = {
        manifest: false,
        chunks: new Set(),
        keyIndex: false,
        keyFragments: new Set(),
        completed: false,
        lastSeen: at,
      };
      this.archiveProgress.set(progressKey, progress);
      while (this.archiveProgress.size > this.maxEvents) {
        this.archiveProgress.delete(this.archiveProgress.keys().next().value);
      }
    }
    progress.lastSeen = at;
    if (stage === "manifest") progress.manifest = true;
    if (stage === "chunk" && Number.isInteger(index)) progress.chunks.add(index);
    if (stage === "key-index") progress.keyIndex = true;
    if (stage === "key-fragment" && Number.isInteger(index)) progress.keyFragments.add(index);

    const traversedSequence = progress.manifest &&
      progress.chunks.size === chunkCount &&
      progress.keyIndex &&
      progress.keyFragments.size === keyCount;
    const justCompleted = stage === "complete" && traversedSequence && !progress.completed;
    if (justCompleted) {
      progress.completed = true;
      this.counters.archiveCompletions += 1;
    }
    this.#push({
      type: justCompleted ? "archive_complete" : "archive_visit",
      at,
      fingerprint,
      session,
      archiveId,
      stage,
      index,
      cacheHit,
      bytes,
      sequenceComplete: progress.completed,
    });
  }

  markBlocked(fingerprint, reason = "trap-depth", at = Date.now()) {
    const record = this.#fingerprintRecord(fingerprint, at);
    record.blocked = true;
    record.lastSeen = at;
    this.fingerprints.set(fingerprint, record);
    this.#push({ type: "block_mark", at, fingerprint, reason });
  }

  isBlocked(fingerprint) {
    return this.getFingerprint(fingerprint).blocked;
  }

  summary(mode) {
    const trapDepths = [...this.fingerprints.values()]
      .filter((record) => record.maxTrapDepth >= 0)
      .map((record) => record.maxTrapDepth);
    const activeFingerprints = [...this.fingerprints.values()].filter(
      (record) => Date.now() - record.lastSeen < 5 * 60_000,
    ).length;
    return {
      mode,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      ...structuredClone(this.counters),
      uniqueFingerprints: this.fingerprints.size,
      activeFingerprints,
      blockedFingerprints: [...this.fingerprints.values()].filter((record) => record.blocked).length,
      averageTrapDepth:
        trapDepths.length === 0
          ? 0
          : Number((trapDepths.reduce((sum, depth) => sum + depth, 0) / trapDepths.length).toFixed(2)),
      cacheHitRate:
        this.counters.cacheHits + this.counters.cacheMisses === 0
          ? 0
          : Number(
              (
                this.counters.cacheHits /
                (this.counters.cacheHits + this.counters.cacheMisses)
              ).toFixed(4),
            ),
      edgeServedTrapPages: this.counters.trapVisits,
      edgeServedArchiveResources: this.counters.archiveVisits,
      originTrapRequests: 0,
      originArchiveRequests: 0,
    };
  }

  // Decision histogram by client class over the bounded event window. In
  // observe-only mode the recorded decisions are shadow decisions (what would
  // have happened), which makes this the real-traffic calibration report.
  baseline() {
    const matrix = {};
    for (const event of this.events) {
      if (event.type !== "request") continue;
      const key = event.userAgentClass ?? "unknown";
      const row = matrix[key] ??= { requests: 0, allow: 0, observe: 0, tarpit: 0, block: 0 };
      row.requests += 1;
      if (row[event.decision] != null) row[event.decision] += 1;
    }
    return matrix;
  }
}
