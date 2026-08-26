import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";
import { createGateway } from "../src/app.js";
import { MODES } from "../src/config.js";
import { PROFILE_NAMES, runClient } from "./clients.js";

function ratio(value, baseline) {
  if (baseline === 0) return null;
  return Number((value / baseline).toFixed(2));
}

export async function runBenchmark(options = {}) {
  const modes = options.modes ?? MODES;
  const profiles = options.profiles ?? PROFILE_NAMES;
  const gateway = createGateway({
    mode: "none",
    port: 0,
    tokenSecret: "benchmark-token-secret-that-is-at-least-32-bytes",
    fingerprintSalt: "benchmark-fingerprint-salt-at-least-32-bytes",
    autoBlock: true,
    autoBlockDepth: 4,
    debugHeaders: true,
  });
  const address = await gateway.start(0, "127.0.0.1");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const results = [];

  try {
    for (const mode of modes) {
      gateway.setMode(mode);
      for (const profile of profiles) {
        gateway.reset();
        const client = await runClient(baseUrl, profile, { maxRequests: options.maxRequests ?? 24 });
        const server = gateway.telemetry.summary(mode);
        results.push({ mode, profile, client, server });
      }
    }
  } finally {
    await gateway.stop();
  }

  const baselines = new Map(
    results.filter((item) => item.mode === "none").map((item) => [item.profile, item.client]),
  );
  return {
    generatedAt: new Date().toISOString(),
    results: results.map((item) => {
      const baseline = baselines.get(item.profile);
      return {
        ...item,
        multipliers: {
          requests: ratio(item.client.requests, baseline.requests),
          bytes: ratio(item.client.bytes, baseline.bytes),
          estimatedTokens: ratio(item.client.estimatedTokens, baseline.estimatedTokens),
        },
      };
    }),
  };
}

function printReport(report) {
  const rows = report.results.map(({ mode, client, multipliers, server }) => ({
    模式: mode,
    客户端: client.label,
    请求: client.requests,
    "请求倍率": `${multipliers.requests}x`,
    "字节倍率": `${multipliers.bytes}x`,
    "估算令牌倍率": `${multipliers.estimatedTokens}x`,
    "迷宫页": client.trapPages,
    "档案资源": client.archivePages,
    "档案解密": client.archiveDecryptionValid ? "通过" : "—",
    "正文召回": `${Math.round(client.canonicalRecall * 100)}%`,
    "探针召回": client.probeRecall == null ? "—" : `${Math.round(client.probeRecall * 100)}%`,
    "缓存命中": `${Math.round(server.cacheHitRate * 100)}%`,
  }));
  console.log("\nAI Deception Gateway benchmark\n");
  console.table(rows);
  console.log("说明：上下文代理是确定性的压缩模拟器，不调用外部模型。生产结论需要接入至少三种真实代理复测。\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runBenchmark();
  const jsonArgument = process.argv.find((argument) => argument.startsWith("--json"));
  if (jsonArgument) {
    const outputPath = jsonArgument.includes("=") ? jsonArgument.slice(jsonArgument.indexOf("=") + 1) : "";
    if (outputPath) {
      await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      console.log(`Benchmark JSON written to ${outputPath}`);
    } else {
      console.log(JSON.stringify(report, null, 2));
    }
  } else {
    printReport(report);
  }
}
