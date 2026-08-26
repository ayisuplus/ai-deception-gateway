import { classifyUserAgent, verifyBotRequest } from "./security.js";

const USER_AGENT_SCORES = Object.freeze({
  "ai-crawler": 80,
  "generic-crawler": 65,
  "automation-client": 45,
  "search-crawler": 25,
  "unknown-client": 15,
  missing: 25,
  browser: 0,
});

export function classifyRequest(request, context) {
  const verification = verifyBotRequest(request, context.config.verifiedBots, context.now);
  const userAgent = String(request.headers.get("user-agent") ?? "");
  const userAgentClass = classifyUserAgent(userAgent);

  if (verification.verified) {
    return {
      decision: "allow",
      score: 0,
      verifiedBotId: verification.botId,
      userAgentClass,
      reasons: ["cryptographically-verified-bot"],
    };
  }

  let score = USER_AGENT_SCORES[userAgentClass] ?? 0;
  const reasons = [];
  if (score > 0) reasons.push(`user-agent:${userAgentClass}`);

  const acceptLanguage = request.headers.get("accept-language");
  if (!acceptLanguage && userAgentClass !== "search-crawler") {
    score += 10;
    reasons.push("missing-accept-language");
  }

  const accept = String(request.headers.get("accept") ?? "");
  if (!accept.includes("text/html") && !accept.includes("application/xhtml+xml")) {
    score += 10;
    reasons.push("non-browser-accept");
  }

  if (context.recentRequests >= 8) {
    score += 25;
    reasons.push("high-request-rate");
  }

  if (context.trapDepth >= 2) {
    score = Math.max(score, 100);
    reasons.push("labyrinth-traversal");
  }

  let decision = "allow";
  if (score >= 95) decision = "block";
  else if (score >= 50) decision = "tarpit";
  else if (score >= 20) decision = "observe";

  return {
    decision,
    score,
    verifiedBotId: null,
    userAgentClass,
    reasons: reasons.length > 0 ? reasons : ["browser-like-traffic"],
  };
}
