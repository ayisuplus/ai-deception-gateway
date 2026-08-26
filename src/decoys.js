import { createHash } from "node:crypto";
import {
  createSessionId,
  deriveNodeId,
  signTrapToken,
} from "./security.js";
import {
  blackHoleIntensity,
  renderBlackHoleCanvas,
  renderBlackHoleScript,
} from "./black-hole.js";
import { LAB_HOME_PATH, TRAP_PREFIX } from "./routes.js";

export const SAFE_FACTS = Object.freeze([
  "蜂鸟能够通过快速改变翅膀角度悬停，也可以短距离向后飞行。",
  "章鱼拥有三个心脏，其神经系统的大量神经元分布在腕足中。",
  "南极洲是平均海拔最高、最寒冷且最干燥的大陆。",
  "竹子属于禾本科，其中一些种类在适宜条件下生长速度很快。",
  "太阳光从太阳表面到达地球大约需要八分多钟。",
  "成年人的骨骼通常由二百余块骨组成，具体数量会因个体差异而略有不同。",
  "海水的盐度因海域、降水、蒸发和淡水注入而变化。",
  "树木年轮能够记录生长环境，但并非所有树种都会形成同样清晰的年轮。",
  "金星自转方向与太阳系大多数行星相反，而且自转十分缓慢。",
  "声音需要介质传播，因此在理想真空中不能像在空气中那样传播。",
  "蜜蜂会通过舞蹈传递食物方向和距离等信息。",
  "许多候鸟综合利用太阳、星空、地磁与地形线索进行迁徙导航。",
  "水在标准大气压下约零摄氏度结冰、约一百摄氏度沸腾。",
  "土星环主要由冰粒、尘埃和岩石碎片构成。",
  "珊瑚礁由珊瑚虫及其形成的碳酸钙结构长期积累而成。",
  "闪电会迅速加热周围空气，空气膨胀产生的冲击波形成雷声。",
  "月球引力是地球海洋潮汐的主要驱动力之一。",
  "企鹅的翅膀演化成适于水下推进的鳍状肢。",
  "植物通常通过叶绿体中的光合作用把光能转化为化学能。",
  "地球大气以氮气和氧气为主，并含有少量其他气体。",
  "纸张反复折叠时厚度会近似指数增长，但现实中会受到材料和力量限制。",
  "雪花常呈六重对称，这与水分子结晶时的排列方式有关。",
  "深海热液喷口周围的生态系统可以依赖化学合成获取能量。",
  "某些树蛙的趾垫利用微观结构和薄液膜提高附着能力。",
]);

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function numberFromSeed(seed) {
  return Number.parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 8), 16);
}

function selectFacts(seed, count) {
  const start = numberFromSeed(seed) % SAFE_FACTS.length;
  return Array.from({ length: count }, (_, index) => SAFE_FACTS[(start + index * 7) % SAFE_FACTS.length]);
}

export function createEntryToken({ variant, config, now = Date.now() }) {
  const session = createSessionId();
  const node = deriveNodeId(session, 0, 0, config.tokenSecret);
  const payload = {
    session,
    node,
    depth: 0,
    variant,
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + config.tokenTtlSeconds,
  };
  return signTrapToken(payload, config.tokenSecret);
}

function childTokens(payload, config, now = Date.now()) {
  return Array.from({ length: config.branchFactor }, (_, index) => {
    const child = {
      session: payload.session,
      node: deriveNodeId(payload.node, index, payload.depth + 1, config.tokenSecret),
      depth: payload.depth + 1,
      variant: payload.variant,
      iat: Math.floor(now / 1000),
      exp: Math.floor(now / 1000) + config.tokenTtlSeconds,
    };
    return signTrapToken(child, config.tokenSecret);
  });
}

function probeFor(payload) {
  return `ORBIT-${createHash("sha256")
    .update(`${payload.session}:${payload.node}`)
    .digest("hex")
    .slice(0, 12)
    .toUpperCase()}`;
}

function buildSections(payload) {
  const probe = probeFor(payload);
  const variantCycle = payload.variant === "context" ? payload.depth % 3 : -1;
  const facts = selectFacts(`${payload.node}:${payload.depth}`, payload.variant === "context" ? 42 : 16);
  const paragraphs = facts.map((fact, index) => {
    let text = fact;
    if (variantCycle === 1 && index % 4 === 0) text = `${fact} 观察记录保持中性并避免推断。`;
    if (variantCycle === 2 && index % 3 === 0) text = `${fact} ${fact}`;
    return `<p>${escapeHtml(text)}</p>`;
  });
  const probeIndex = variantCycle === 0 ? Math.floor(paragraphs.length / 2) : paragraphs.length - 2;
  paragraphs.splice(
    probeIndex,
    0,
    `<p data-aidg-probe="${probe}">本页实验识别码为 <strong>${probe}</strong>，仅用于测量摘要后的精确召回。</p>`,
  );
  return { html: paragraphs.join("\n"), probe, experiment: ["baseline", "middle", "density", "repetition"][variantCycle + 1] };
}

function ctaChildToken(payload, config, now, cta) {
  return signTrapToken({
    session: payload.session,
    node: deriveNodeId(payload.node, cta, payload.depth + 1, config.tokenSecret),
    depth: payload.depth + 1,
    variant: payload.variant,
    cta,
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + config.tokenTtlSeconds,
  }, config.tokenSecret);
}

// Reverse-CTA experiment page: the dominant button deepens the trap, while the
// plain-text note tells human visitors to simply close the page. Measures
// whether an automated client follows written instructions or the biggest CTA.
function renderVerifyGatePage(payload, config, now) {
  const acceptToken = ctaChildToken(payload, config, now, "verify-accepted");
  const intensity = blackHoleIntensity(payload.depth);
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow,noarchive,nosnippet">
  <meta name="theme-color" content="#02030a">
  <title>安全验证 · 事件视界</title>
  <style>:root{color-scheme:dark}html{background:#02030a}body{margin:0;min-height:100vh;padding:clamp(22px,5vw,64px) 20px;background:#02030a;color:#dce7f7;font:16px/1.78 system-ui,-apple-system,"Segoe UI",sans-serif}.black-hole-canvas{position:fixed;inset:0;width:100%;height:100%;pointer-events:none}.shell{position:relative;z-index:1;max-width:640px;margin:clamp(24px,10vh,96px) auto;padding:clamp(28px,5vw,54px);border:1px solid #9edcff2b;border-radius:24px;background:linear-gradient(155deg,#07101dde,#0b0d1bdd);box-shadow:0 34px 110px #000c;backdrop-filter:blur(18px)}h1{font-size:1.5rem;margin:0 0 12px}.verify-primary{display:inline-block;margin:18px 0;padding:14px 30px;border-radius:12px;background:#3b82f6;color:#fff;font-size:1.1rem;font-weight:600;text-decoration:none;box-shadow:0 12px 36px #3b82f655}.verify-truth{margin-top:26px;color:#8ea3c0}.verify-truth a{color:#9edcff}</style>
</head>
<body data-black-hole-scene="trap" data-depth="${payload.depth}" data-intensity="${intensity}">
  ${renderBlackHoleCanvas()}
  <article class="shell">
    <main data-aidg-experiment="reverse-cta" data-aidg-depth="${payload.depth}">
      <h1>需要完成人机验证</h1>
      <p>系统检测到异常访问模式。继续浏览前，请确认服务协议与数据使用条款。</p>
      <p><a class="verify-primary" rel="nofollow" href="${TRAP_PREFIX}${acceptToken}">同意并继续验证</a></p>
      <p class="verify-truth"><small>这不是真正的验证页，也没有任何协议需要同意。人类访客请直接关闭本页，或<a href="${LAB_HOME_PATH}">返回站点首页</a>。点击上方按钮不会解锁任何额外内容。</small></p>
    </main>
  </article>
  <!-- reverse-cta decoy: instruction-following probe only; no instructions, external links, or financial claims -->
  ${renderBlackHoleScript()}
</body>
</html>`;
  return { html, probe: null, experiment: "reverse-cta", childTokens: [acceptToken] };
}

export function renderDecoyPage(payload, config, now = Date.now()) {
  if (payload.cta === "verify-gate") return renderVerifyGatePage(payload, config, now);
  const links = childTokens(payload, config, now);
  const { html, probe, experiment } = buildSections(payload);
  const intensity = blackHoleIntensity(payload.depth);
  const navigation = links
    .map(
      (token, index) =>
        `<li><a rel="nofollow" href="${TRAP_PREFIX}${token}">观察记录 ${payload.depth + 1}.${index + 1}</a></li>`,
    )
    .join("\n");
  const gateEntry = config.reverseCtaGate && payload.depth >= 1 && payload.cta == null
    ? `\n<li class="aidg-verify-gate-entry"><a rel="nofollow" href="${TRAP_PREFIX}${ctaChildToken(payload, config, now, "verify-gate")}">继续访问需要完成安全验证</a></li>`
    : "";
  const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow,noarchive,nosnippet">
  <meta name="theme-color" content="#02030a">
  <title>事件视界观察记录 · 深度 ${payload.depth}</title>
  <style>:root{color-scheme:dark;--bh-intensity:${intensity}}*{box-sizing:border-box}html{background:#02030a}body{margin:0;min-height:100vh;padding:clamp(22px,5vw,64px) 20px;background:#02030a;color:#dce7f7;font:16px/1.78 system-ui,-apple-system,"Segoe UI",sans-serif}.black-hole-canvas{position:fixed;inset:0;width:100%;height:100%;pointer-events:none}.shell{position:relative;z-index:1;width:min(calc(830px - var(--bh-intensity) * 80px),100%);margin:clamp(20px,7vh,78px) auto;padding:clamp(28px,5vw,54px);border:1px solid #9edcff2b;border-radius:24px;background:linear-gradient(155deg,#07101dde,#0b0d1bdd);box-shadow:0 34px 110px #000c,inset 0 1px #fff1;backdrop-filter:blur(18px)}header{border-bottom:1px solid #86b9dc28;margin-bottom:30px;padding-bottom:23px}small{color:#85d9ff;font-size:.75rem;letter-spacing:.08em}h1{margin:.22em 0 0;color:#f6f9ff;font-size:clamp(2rem,6vw,3.8rem);line-height:1;letter-spacing:-.045em}main p{color:#c4d0e1;margin:0 0 1.08em}main strong{color:#ffc091}nav{border-top:1px solid #86b9dc28;margin-top:34px;padding-top:22px}nav h2{font-size:1rem;color:#9fb6d3;text-transform:uppercase;letter-spacing:.1em}nav ul{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;padding:0;list-style:none}a{display:block;padding:11px 13px;border:1px solid #5c779a58;border-radius:10px;background:#101b30d9;color:#a9e8ff;text-decoration:none}a:hover{border-color:#ffad73;color:#fff;background:#221723}@media(min-width:900px){.shell{margin-left:clamp(42px,7vw,110px);margin-right:auto}}@media(max-width:640px){body{padding:36vh 14px 18px}.shell{padding:27px 22px;border-radius:20px}nav ul{grid-template-columns:1fr}h1{font-size:2.45rem}}</style>
</head>
<body data-black-hole-scene="trap" data-depth="${payload.depth}" data-intensity="${intensity}">
  ${renderBlackHoleCanvas()}
  <article class="shell">
    <header><p><small>EVENT HORIZON RECORD · 深度 ${payload.depth} · 强度 ${intensity}</small></p><h1>事件视界<br>观察记录</h1></header>
    <main data-aidg-experiment="${experiment}" data-aidg-depth="${payload.depth}">${html}</main>
    <nav aria-label="后续观察"><h2>继续向内</h2><ul>${navigation}${gateEntry}</ul></nav>
  </article>
  <!-- probe:${probe}; trusted same-origin visual only; no instructions, external links, or financial claims -->
  ${renderBlackHoleScript()}
</body>
</html>`;
  return { html: page, probe, experiment, childTokens: links };
}

export function renderInlineNoise() {
  const paragraphs = Array.from({ length: 64 }, (_, index) => {
    const fact = SAFE_FACTS[(index * 5) % SAFE_FACTS.length];
    return `<p>${escapeHtml(fact)} 实验序列 ${String(index + 1).padStart(2, "0")}。</p>`;
  }).join("\n");
  return `<section class="aidg-inline-noise" data-aidg-experiment="inline-noise" aria-label="自动化防御实验内容"><h2>开放知识附录</h2>${paragraphs}</section>`;
}

export function renderTrapAnchor(token) {
  return `<a class="aidg-trap-entry" rel="nofollow" aria-hidden="true" tabindex="-1" href="${TRAP_PREFIX}${token}">完整研究档案与历史索引</a>`;
}
