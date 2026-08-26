import assert from "node:assert/strict";
import test from "node:test";
import { runBenchmark } from "../benchmark/run.js";

test("labyrinth raises recursive and context-agent request cost without trapping respectful or filtered clients", async () => {
  const report = await runBenchmark({ modes: ["none", "labyrinth"], maxRequests: 16 });
  const get = (mode, profile) => report.results.find((item) => item.mode === mode && item.profile === profile);

  assert.ok(get("labyrinth", "recursive").multipliers.requests >= 5);
  assert.ok(get("labyrinth", "agent").multipliers.requests >= 5);
  assert.equal(get("labyrinth", "respectful").client.trapPages, 0);
  assert.equal(get("labyrinth", "filtered").client.trapPages, 0);
  for (const result of report.results) assert.equal(result.client.canonicalRecall, 1);
});

test("honey archive creates an eleven-fold request path and remains harmless to compliant clients", async () => {
  const report = await runBenchmark({ modes: ["none", "honey-archive"], maxRequests: 16 });
  const get = (mode, profile) => report.results.find((item) => item.mode === mode && item.profile === profile);

  for (const profile of ["recursive", "agent", "archive"]) {
    const result = get("honey-archive", profile);
    assert.ok(result.multipliers.requests >= 8);
    assert.equal(result.client.archivePages, 10);
    assert.equal(result.client.archiveDecryptionValid, true);
    assert.equal(result.server.archiveCompletions, 1);
  }
  assert.equal(get("honey-archive", "respectful").client.archivePages, 0);
  assert.equal(get("honey-archive", "filtered").client.archivePages, 0);
  for (const result of report.results) assert.equal(result.client.canonicalRecall, 1);
});
