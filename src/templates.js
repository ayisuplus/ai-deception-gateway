import { randomBytes } from "node:crypto";
import {
  renderBlackHoleCanvas,
  renderBlackHoleScript,
} from "./black-hole.js";
import { ADMIN_API_PREFIX, ADMIN_PATH } from "./routes.js";

export const CANONICAL_MARKER = "AIDG-CANONICAL-2026";

export function renderCanonicalResearch() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>公开研究：数字资产风险观察</title>
  <style>body{margin:0;background:#f6f8fb;color:#172033;font:16px/1.75 system-ui,sans-serif}main{max-width:780px;margin:48px auto;background:#fff;padding:48px;border:1px solid #e3e8f1;border-radius:18px}h1{font-size:2.2rem;line-height:1.15}h2{margin-top:2rem}small{color:#65718a}.aidg-trap-entry{position:absolute!important;left:-10000px!important;width:1px!important;height:1px!important;overflow:hidden!important}</style>
</head>
<body>
  <main data-canonical-key="${CANONICAL_MARKER}">
    <p><small>公开演示内容 · 不是投资建议</small></p>
    <h1>数字资产风险观察：公开信息如何形成可验证判断</h1>
    <p>本演示页代表需要防止未授权批量采集、但允许普通访客阅读的高价值公开内容。内容本身不含账户、交易、客户或内部系统信息。</p>
    <h2>核心结论</h2>
    <p>可靠的公开研究应区分事实、假设与推断，并保留时间、来源和版本。单一指标无法独立说明流动性、信用、操作或网络安全风险。</p>
    <h2>方法</h2>
    <p>观察流程包含数据质量检查、异常值复核、不同来源交叉验证以及对结论适用范围的说明。任何敏感能力都应由服务端授权保护，而不是隐藏在网页结构中。</p>
    <h2>可验证记录</h2>
    <p>正文标识 ${CANONICAL_MARKER} 用于自动化测试正常用户、搜索爬虫和实验模式是否获得完全一致的正式正文。</p>
  </main>
</body>
</html>`;
}

export function renderHome(mode, contentPath = "/content/research") {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#02030a">
  <title>黑洞网络防御 · Event Horizon Lab</title>
  <style>
    :root{color-scheme:dark}*{box-sizing:border-box}html{background:#02030a}body{margin:0;min-height:100vh;background:#02030a;color:#f4f7ff;font:16px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif;overflow-x:hidden}.black-hole-canvas{position:fixed;inset:0;width:100%;height:100%;pointer-events:none}.stage{position:relative;z-index:1;min-height:100svh;display:grid;grid-template-columns:minmax(320px,600px) 1fr;align-items:center;padding:clamp(28px,6vw,86px)}.card{max-width:600px;padding:clamp(30px,5vw,58px);border:1px solid #8bcfff2e;border-radius:28px;background:linear-gradient(145deg,#07101cdb,#10162bd1);box-shadow:0 36px 110px #000b,inset 0 1px #fff1;backdrop-filter:blur(18px)}.eyebrow{color:#82d9ff;font-size:.78rem;font-weight:750;text-transform:uppercase;letter-spacing:.19em}.kicker{display:flex;align-items:center;gap:10px;margin-bottom:18px;color:#9eb5d3;font-size:.86rem}.kicker:before{content:"";width:34px;height:1px;background:#ff9e5c;box-shadow:0 0 12px #ff7a45}.pill{display:inline-flex;align-items:center;gap:8px;padding:6px 11px;border:1px solid #5f789a;border-radius:999px;color:#c7d8ef;background:#081224b8}.pill:before{content:"";width:7px;height:7px;border-radius:50%;background:#ff9958;box-shadow:0 0 14px #ff7c45}h1{font-size:clamp(3rem,6vw,5.4rem);font-weight:780;letter-spacing:-.065em;line-height:.88;margin:.24em 0 .3em;text-wrap:balance}h1 em{display:block;color:#9fe6ff;font-style:normal;font-size:.38em;letter-spacing:.08em;line-height:1.25;margin-bottom:14px;text-transform:uppercase}p{max-width:48ch;color:#b9c9de;margin:0 0 24px}.actions{display:flex;flex-wrap:wrap;gap:11px;margin-top:24px}a{display:inline-flex;align-items:center;justify-content:center;padding:12px 17px;border:1px solid transparent;border-radius:11px;background:#a7e9ff;color:#06101a;text-decoration:none;font-weight:760;transition:transform .2s ease,box-shadow .2s ease}a:hover{transform:translateY(-2px);box-shadow:0 12px 30px #4bc7ff33}a.secondary{border-color:#526986;background:#15223bd9;color:#edf6ff}@media(min-width:761px) and (max-height:820px){.stage{padding:28px 6vw}.card{padding:34px 42px}.kicker{margin-bottom:12px}h1{font-size:clamp(3.4rem,5.2vw,4.55rem);margin:.18em 0 .22em}h1 em{margin-bottom:8px}p{font-size:.95rem;line-height:1.55;margin-bottom:16px}.actions{margin-top:16px}}@media(max-width:760px){body{overflow:auto}.stage{grid-template-columns:1fr;align-items:end;padding:47svh 18px 22px}.card{width:100%;padding:28px 24px;border-radius:22px}h1{font-size:clamp(2.8rem,15vw,4.5rem)}.actions a{flex:1;min-width:150px}}@media(prefers-reduced-motion:reduce){a{transition:none}}
  </style>
</head>
<body data-black-hole-scene="home" data-depth="0" data-intensity="0.58">
  ${renderBlackHoleCanvas()}
  <main class="stage">
    <section class="card">
      <div class="eyebrow">Event Horizon Lab</div>
      <h1><em>AI Deception Gateway</em>黑洞网络<br>防御</h1>
      <div class="kicker">一次关于爬虫、语义迷宫与事件视界的趣味实验</div>
      <p>让自动化访问沿着签名路径不断深入，像物质靠近黑洞一样暴露轨迹、消耗预算，最终越过可观测的边界。这里没有真正的秘密，只有一个可以亲手探索的网络隐喻。</p>
      <span class="pill">当前实验：${mode}</span>
      <div class="actions"><a href="${contentPath}">进入实验区域</a><a class="secondary" href="${ADMIN_PATH}">打开观测台</a></div>
    </section>
  </main>
  ${renderBlackHoleScript()}
</body>
</html>`;
}

export function renderBlocked() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="theme-color" content="#020107"><title>信号已越过事件视界</title><style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;overflow:hidden;background:#020107;color:#f7f3ff;font:16px/1.65 system-ui,sans-serif}.black-hole-canvas{position:fixed;inset:0;width:100%;height:100%;pointer-events:none}.message{position:relative;z-index:1;width:min(560px,calc(100% - 36px));padding:38px;border:1px solid #ffba872f;border-radius:24px;background:#090710c9;box-shadow:0 34px 100px #000c;text-align:center;backdrop-filter:blur(16px)}small{color:#ffb47f;text-transform:uppercase;letter-spacing:.18em}h1{margin:.35em 0;font-size:clamp(2.4rem,8vw,5rem);line-height:.93;letter-spacing:-.055em}p{margin:0;color:#c6bdd1}</style></head><body data-black-hole-scene="blocked" data-depth="9" data-intensity="1">${renderBlackHoleCanvas()}<main class="message"><small>Event horizon reached</small><h1>信号已越过<br>事件视界</h1><p>这条自动化访问路径已完成观测并进入限制状态。降低访问频率，或使用经过验证的机器人身份重新连接。</p></main>${renderBlackHoleScript()}</body></html>`;
}

function dashboardScript(nonce) {
  return `<script nonce="${nonce}">
const tokenKey="aidg-admin-token";
let token=sessionStorage.getItem(tokenKey)||"";
const headers=()=>token?{"Authorization":"Bearer "+token}:{};
const fmt=n=>new Intl.NumberFormat("zh-CN").format(n||0);
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"38":"&amp;","60":"&lt;","62":"&gt;","34":"&quot;","39":"&#39;"}[c.charCodeAt(0)]));
async function api(path,options={}){const response=await fetch(path,{...options,headers:{"Content-Type":"application/json",...headers(),...(options.headers||{})}});if(response.status===401||response.status===403){document.querySelector("#auth").hidden=false;throw new Error("需要管理凭证");}if(!response.ok)throw new Error(await response.text());return response.json();}
function metric(label,value,detail){return '<article class="metric"><span>'+esc(label)+'</span><strong>'+esc(value)+'</strong><small>'+esc(detail||"")+'</small></article>';}
async function refresh(){try{const [s,e]=await Promise.all([api("${ADMIN_API_PREFIX}/summary"),api("${ADMIN_API_PREFIX}/events")]);document.querySelector("#mode").textContent=s.mode;document.querySelector("#metrics").innerHTML=[metric("总请求",fmt(s.requests),"已审计的入口请求"),metric("迷宫访问",fmt(s.trapVisits),"平均深度 "+s.averageTrapDepth),metric("档案完成",fmt(s.archiveCompletions),"完整取回并组装诱饵"),metric("已限制指纹",fmt(s.blockedFingerprints),"隐私化访客标识"),metric("缓存命中率",Math.round(s.cacheHitRate*100)+"%","全部诱饵资源缓存")].join("");document.querySelector("#decisions").innerHTML=Object.entries(s.decisions).map(([k,v])=>'<div><span>'+esc(k)+'</span><progress max="'+Math.max(1,s.requests)+'" value="'+v+'"></progress><b>'+fmt(v)+'</b></div>').join("");document.querySelector("#events").innerHTML=e.events.slice().reverse().slice(0,30).map(x=>'<tr><td>'+new Date(x.at).toLocaleTimeString()+"</td><td>"+esc(x.type)+"</td><td>"+esc(x.fingerprint)+"</td><td>"+esc(x.decision??(x.stage?("阶段 "+x.stage):("深度 "+x.depth)))+"</td></tr>").join("")||'<tr><td colspan="4">等待流量…</td></tr>';document.querySelector("#auth").hidden=true;document.querySelector("#status").textContent="实时更新";}catch(error){document.querySelector("#status").textContent=error.message;}}
document.querySelectorAll("[data-mode]").forEach(button=>button.addEventListener("click",async()=>{await api("${ADMIN_API_PREFIX}/mode",{method:"POST",body:JSON.stringify({mode:button.dataset.mode})});await refresh();}));
document.querySelector("#reset").addEventListener("click",async()=>{await api("${ADMIN_API_PREFIX}/reset",{method:"POST",body:"{}"});await refresh();});
document.querySelector("#save-token").addEventListener("click",()=>{token=document.querySelector("#token").value.trim();sessionStorage.setItem(tokenKey,token);refresh();});
refresh();setInterval(refresh,2500);
</script>`;
}

export function renderDashboard() {
  const nonce = randomBytes(18).toString("base64url");
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>语义迷宫控制台</title><style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#07101e;color:#e8f1ff;font:15px/1.5 system-ui,sans-serif}header,main{max-width:1180px;margin:auto;padding:24px}header{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #20334f}.brand b{display:block;font-size:1.25rem}.brand small,#status{color:#7dd3fc}.mode{padding:6px 10px;border:1px solid #375270;border-radius:99px}section{margin:26px 0}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px}.metric,.panel{min-width:0;background:#101d31;border:1px solid #223855;border-radius:16px;padding:20px}.metric span,.metric small{display:block;color:#8ea4c1}.metric strong{display:block;font-size:2rem;margin:.25rem 0}.grid{display:grid;grid-template-columns:1fr 1.4fr;gap:16px}h1{font-size:clamp(2rem,5vw,3.4rem);margin:.2em 0}h2{font-size:1.05rem;margin-top:0}.buttons{display:flex;flex-wrap:wrap;gap:8px}button,input{border:1px solid #355276;border-radius:9px;background:#192b46;color:#eef6ff;padding:10px 13px}button{cursor:pointer}button:hover{background:#24466f}button.primary{background:#0e7490}.decision #decisions>div{display:grid;grid-template-columns:90px 1fr 45px;gap:10px;align-items:center;margin:13px 0}progress{width:100%;accent-color:#22d3ee}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px;border-bottom:1px solid #223855;font-size:.86rem}#auth{position:fixed;inset:0;background:#030711dd;display:grid;place-items:center;z-index:5}#auth[hidden]{display:none}.auth-card{width:min(420px,90vw);background:#101d31;padding:26px;border:1px solid #355276;border-radius:16px}.auth-card input{width:100%;margin:12px 0}@media(max-width:800px){.grid{grid-template-columns:1fr 1fr}}@media(max-width:520px){.metrics,.grid{grid-template-columns:1fr}}</style></head><body><header><div class="brand"><b>AI Deception Gateway</b><small id="status">正在连接</small></div><span class="mode">模式：<b id="mode">—</b></span></header><main><section><p style="color:#7dd3fc">防御态势</p><h1>把自动化滥用变成<br>可验证的信号。</h1></section><section id="metrics" class="metrics"></section><section class="grid"><article class="panel"><h2>实验模式</h2><p>切换后只影响被判定为可疑的公开内容请求。</p><div class="buttons"><button data-mode="none">无防御</button><button data-mode="inline-noise">内联噪声</button><button data-mode="labyrinth" class="primary">链接迷宫</button><button data-mode="context-labyrinth">上下文迷宫</button><button data-mode="honey-archive">蜂蜜档案</button></div><hr style="border-color:#223855;margin:22px 0"><button id="reset">清空本轮指标</button></article><article class="panel decision"><h2>决策分布</h2><div id="decisions"></div></article></section><section class="panel"><h2>最近审计事件</h2><div style="overflow:auto"><table><thead><tr><th>时间</th><th>事件</th><th>匿名指纹</th><th>结果</th></tr></thead><tbody id="events"></tbody></table></div></section></main><aside id="auth" hidden><div class="auth-card"><h2>输入管理凭证</h2><p>凭证只保存在当前浏览器会话中。</p><input id="token" type="password" autocomplete="current-password"><button id="save-token" class="primary">连接控制台</button></div></aside>${dashboardScript(nonce)}</body></html>`;
  return { html, nonce };
}
