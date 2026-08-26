import http from "node:http";
import { createGateway } from "../../src/app.js";

const originPort = 8790;
const gatewayPort = 8787;

const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Event Horizon Component Host</title>
  <style>
    *{box-sizing:border-box}body{margin:0;background:#f4f6fa;color:#132238;font:16px/1.55 system-ui,sans-serif}main{width:min(1080px,calc(100% - 32px));margin:40px auto}h1{font-size:clamp(2rem,5vw,4rem);margin:.2em 0}.intro{max-width:62ch;color:#526277}.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin:28px 0}event-horizon-visual{display:block;width:100%;height:320px;border-radius:22px;box-shadow:0 24px 70px #17213b35}.controls{display:flex;gap:10px;flex-wrap:wrap}button{border:0;border-radius:10px;padding:11px 16px;background:#172a46;color:white;font:inherit;cursor:pointer}button:hover{background:#284b76}@media(max-width:700px){main{margin:24px auto}.grid{grid-template-columns:1fr}event-horizon-visual{height:280px}}
  </style>
  <script defer src="/__event-horizon/assets/black-hole.v1.js"></script>
  <script defer src="/host-controls.js"></script>
</head>
<body>
  <main>
    <small>STRICT CSP · SAME-ORIGIN HOST</small>
    <h1>嵌入式事件视界</h1>
    <p class="intro">这个页面模拟一个拥有自己样式和内容策略的宿主站点。两个黑洞实例互相隔离，按钮用于验证运行时属性更新和卸载清理。</p>
    <section class="grid">
      <event-horizon-visual id="primary-hole" scene="home" depth="0" aria-label="首页黑洞"></event-horizon-visual>
      <event-horizon-visual id="secondary-hole" scene="trap" depth="3" aria-label="迷宫黑洞"></event-horizon-visual>
    </section>
    <div class="controls">
      <button id="update" type="button">提升主黑洞强度</button>
      <button id="remove" type="button">卸载第二个实例</button>
    </div>
  </main>
</body>
</html>`;

const controls = `(() => {
  const primary = document.querySelector("#primary-hole");
  const secondary = document.querySelector("#secondary-hole");
  document.querySelector("#update").addEventListener("click", () => {
    primary.setAttribute("scene", "blocked");
    primary.setAttribute("depth", "9");
    primary.setAttribute("intensity", "1");
    document.body.dataset.updated = "true";
  });
  document.querySelector("#remove").addEventListener("click", () => {
    secondary.remove();
    document.body.dataset.removed = secondary.renderer === null ? "clean" : "leaked";
  });
})();`;

const origin = http.createServer((request, response) => {
  console.log(`origin ${request.method} ${request.url}`);
  if (request.url === "/" || request.url === "/embed") {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; base-uri 'none'",
    });
    response.end(page);
    return;
  }
  if (request.url === "/host-controls.js") {
    response.writeHead(200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(controls);
    return;
  }
  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Not Found");
});

await new Promise((resolve) => origin.listen(originPort, "127.0.0.1", resolve));
const gateway = createGateway({
  port: gatewayPort,
  originUrl: `http://127.0.0.1:${originPort}/`,
  tokenSecret: "embed-preview-token-secret-at-least-32-bytes",
  fingerprintSalt: "embed-preview-fingerprint-salt-at-least-32",
});
await gateway.start(gatewayPort, "127.0.0.1");
console.log(`Embed preview: http://127.0.0.1:${gatewayPort}/embed`);

async function shutdown() {
  await gateway.stop();
  await new Promise((resolve, reject) => origin.close((error) => (error ? reject(error) : resolve())));
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
