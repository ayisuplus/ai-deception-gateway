import {
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";

// Map-compatible fingerprint store backed by a single JSON file, letting
// multiple gateway processes on one host share rate-limit state. This is the
// reference implementation for the multi-instance seam: synchronous,
// last-writer-wins, and meant for low write rates. Production deployments
// should replace it with an edge KV / Redis adapter exposing the same
// Map-like surface (get/set/delete/has/keys/values/size/clear).
//
// Writes are debounced except when a record's blocked flag flips to true —
// rate-limit marks must propagate immediately. Reads reload only when the
// file's mtime changed, so the hot path is a statSync plus a Map lookup.
export class SharedFingerprintMap {
  constructor(path, { flushIntervalMs = 250 } = {}) {
    this.path = path;
    this.flushIntervalMs = flushIntervalMs;
    this.cache = new Map();
    this.mtimeMs = 0;
    this.dirtyKeys = new Set();
    this.timer = null;
    this.#load(true);
  }

  #load(force = false) {
    let stat;
    try {
      stat = statSync(this.path);
    } catch {
      if (force) this.mtimeMs = 0;
      return;
    }
    if (!force && stat.mtimeMs === this.mtimeMs) return;
    try {
      this.cache = new Map(JSON.parse(readFileSync(this.path, "utf8")));
      this.mtimeMs = stat.mtimeMs;
    } catch {
      // Torn read (a peer is mid-rename): keep the current cache.
    }
  }

  #persist(immediate = false) {
    if (immediate) {
      this.#flush();
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => this.#flush(), this.flushIntervalMs);
    this.timer.unref();
  }

  #flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.dirtyKeys.size === 0) return;
    const pending = new Map();
    for (const key of this.dirtyKeys) pending.set(key, this.cache.get(key));
    this.dirtyKeys.clear();
    try {
      // Merge before writing: pull any peer's writes, then re-apply ours on
      // top. A stale debounced flush must never clobber a peer's fresh mark.
      this.#load(true);
      for (const [key, value] of pending) {
        if (value === undefined) this.cache.delete(key);
        else this.cache.set(key, value);
      }
      // Per-process tmp name: two peers renaming the same tmp file crash the
      // loser with ENOENT.
      writeFileSync(`${this.path}.${process.pid}.tmp`, JSON.stringify([...this.cache]));
      renameSync(`${this.path}.${process.pid}.tmp`, this.path);
      this.mtimeMs = statSync(this.path).mtimeMs;
    } catch {
      // A peer raced us or the disk hiccuped: re-mark dirty, retry next write.
      for (const key of pending.keys()) this.dirtyKeys.add(key);
    }
  }

  get size() {
    this.#load();
    return this.cache.size;
  }

  get(key) {
    this.#load();
    return this.cache.get(key);
  }

  has(key) {
    this.#load();
    return this.cache.has(key);
  }

  set(key, value) {
    this.#load();
    this.cache.set(key, value);
    this.dirtyKeys.add(key);
    // Blocked records persist immediately: peers must enforce rate limits
    // promptly. The flag may have been flipped by mutating the cached record,
    // so detection relies on the value, not on a diff.
    this.#persist(value?.blocked === true);
    return this;
  }

  delete(key) {
    this.#load();
    // Local-only: LRU evictions are per-instance policy and are not propagated.
    return this.cache.delete(key);
  }

  clear() {
    this.cache.clear();
    this.dirtyKeys.clear();
    try {
      writeFileSync(`${this.path}.${process.pid}.tmp`, "[]");
      renameSync(`${this.path}.${process.pid}.tmp`, this.path);
      this.mtimeMs = statSync(this.path).mtimeMs;
    } catch {
      // Same race tolerance as #flush.
    }
  }

  *keys() {
    this.#load();
    yield* this.cache.keys();
  }

  *values() {
    this.#load();
    yield* this.cache.values();
  }

  *entries() {
    this.#load();
    yield* this.cache.entries();
  }

  [Symbol.iterator]() {
    return this.entries();
  }

  // Force a reload; used by tests and by operators after out-of-band edits.
  sync() {
    this.#load(true);
  }
}
