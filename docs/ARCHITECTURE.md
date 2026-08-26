# 架构与数据流

## 请求路径

```text
访客 / 爬虫
     │
     ▼
请求身份与行为分类
     │
     ├── allow ────► 原始公开内容
     ├── observe ──► 原始公开内容 + 审计事件
     ├── tarpit ───► 原始内容 + 签名入口 ──┬─► 迷宫节点
     │                                      └─► 蜂蜜档案链
     └── block ────► 429
```

主要模块：

- `src/classifier.js`：密码学身份优先，随后使用客户端类别、请求头完整度、访问速率和已有迷宫深度评分。
- `src/security.js`：匿名指纹、迷宫令牌、节点派生和原型机器人签名。
- `src/decoys.js`：安全事实库、实验探针、迷宫分支和四种内容变体。
- `src/honey-archive.js`：确定性的密文分片、Merkle 校验、密钥分段和签名阶段链接。
- `src/black-hole.js` 与 `public/black-hole.v1.js`：场景参数、严格 CSP 和零依赖 Canvas 渲染器。
- `src/metrics.js`：有界内存事件流、有界匿名访客状态（LRU 淘汰，上限为 `maxEvents`）和聚合指标。
- `src/shared-state.js`：可选的文件后端共享指纹存储（`Map` 兼容接口），供多实例共享限速状态。
- `src/core.js`：与运行时无关的请求核心（标准 `fetch(Request) → Response`）：路由、分类、诱饵注入、上游代理、管理 API。
- `src/app.js`：node:http 适配器，把核心暴露为本地/自托管网关进程。
- `src/node-adapter.js`：node:http 与 web API 之间的请求/响应转换（独立网关与中间件共用）。
- `src/middleware.js`：Connect/Express 中间件适配器：命名空间路由、全路径封禁闸、下游 HTML 注入拦截（显式 `writeHead` 延迟、流出前冲刷）。
- `edge/worker.core.js` 与 `edge/worker.js`：边缘适配器，同一核心部署为 Cloudflare Worker（遥测为单 isolate 内存）。
- `benchmark/clients.js`：五种确定性爬虫策略，包括真实档案解密器。

## 无状态迷宫

入口令牌的有效载荷包含：

```json
{
  "session": "随机会话 ID",
  "node": "派生节点 ID",
  "depth": 0,
  "variant": "baseline 或 context",
  "iat": 0,
  "exp": 0
}
```

令牌由 HMAC-SHA256 保护。每个子节点使用父节点、分支序号和深度继续派生，因此网关无需在数据库中提前创建无限 URL。完整 HTML 响应进入有界 LRU 缓存，并设置 `public, immutable`；所有诱饵都在网关本地生成，`originTrapRequests` 永远为零。

上下文模式按深度轮换三种实验：关键信息位于中部、重复度变化、信息密度变化。页面中的 `ORBIT-*` 只是精确召回探针，不携带指令。
可选的反向 CTA 实验（`AIDG_REVERSE_CTA_GATE`）在深度 ≥1 的迷宫页追加一个伪装成"人机验证"的门页：显眼的"同意并继续验证"按钮实际深化陷阱（计数 `ctaGateViews` / `ctaAccepted`），页面明文告知人类访客直接关闭。它只测量自动化客户端是否跟随页面文字，不拦截任何正常内容。

## 事件视界视觉层

首页、迷宫和限制页分别输出 `data-black-hole-scene="home|trap|blocked"`、`data-depth` 与 `data-intensity`。同源 Canvas 脚本只读取这些展示参数，绘制星空、吸积盘、光子环和简化透镜；它不读取令牌、不调用管理 API、不发起网络请求，也不影响链接和正文 DOM。迷宫强度由深度确定，视觉失败时页面仍保留完整文字和导航。

视觉页的 CSP 只增加 `script-src 'self'`，同时保持 `connect-src 'none'` 并禁止 iframe 嵌套。脚本资源使用版本化 URL 和一年不可变缓存；动画页面不可加载第三方脚本。正式研究正文没有加载视觉脚本，因此正常浏览器和已验证机器人仍获得原始字节。

同一渲染核心还注册 `<event-horizon-visual>`。每个实例使用独立 Shadow DOM、Canvas、尺寸观察器和动画生命周期，公开 `scene / depth / intensity` 属性；卸载时释放动画帧和全部监听器。组件不读取宿主 DOM，也不参与流量分类。

## 单站透明代理

配置 `AIDG_ORIGIN_URL` 后，只有 `/__event-horizon/` 是网关保留命名空间，其他 `GET/HEAD` 路径映射到固定上游。请求中的 Cookie、Authorization 和 hop-by-hop 头（包括 Connection 头提名的自定义头）不会上送；非公开方法由网关拒绝，部署层必须将登录、表单和 API 绕过本服务。

允许和观察响应保持上游正文、状态和端到端响应头。只有成功、UTF-8 的可疑 HTML 可以注入实验入口；修改后移除内容校验器并设置 `private, no-store`。非 UTF-8、非 HTML、下载和错误响应不修改。同源绝对重定向改写为当前站点路径，上游失败统一返回不泄露地址的 `502`。

## 蜂蜜档案协议

`honey-archive` 模式不修改正式正文，只注入一个带 `nofollow` 的签名清单入口。档案链固定为：

```text
清单
  → 密文分片 0 → 1 → 2 → 3
  → 密钥索引
  → 密钥碎片 0 → 1 → 2
  → 完成回执
```

每个阶段 URL 都包含 HMAC-SHA256 签名、会话、档案 ID、阶段、索引和到期时间。安全合成明文使用会话独立的派生密钥和 IV 进行 AES-256-GCM 加密，再拆为 4 个分片；清单提供各分片 SHA-256 与 Merkle 根。AES 密钥由 3 段等长数据异或重组，所有碎片均故意可在站内取回。

这套包装提供的是可信的解析工作量和高置信度访问序列，不提供保密性。解密结果只有内置科学事实、合成声明和 `HONEY-*` 会话金丝雀。没有脚本、外链、真实金融数据、凭据、操作指令或站外副作用。

遥测按匿名指纹和会话记录 `manifest / chunk / key-index / key-fragment / complete`。只有同一指纹实际收齐清单、4 个分片、密钥索引和 3 个碎片后访问完成回执，才产生一次 `archive_complete`；直接跳到回执不会计为完成。所有资源进入同一个有界 LRU 缓存，`originArchiveRequests` 恒为零。

## 公开接口

### 内容与运行状态

- `GET /content/research`：内置公开内容演示。
- `GET /__event-horizon/`：事件视界实验室。
- `GET /__event-horizon/health`：返回运行状态和当前模式。
- `GET /__event-horizon/trap/:token`：签名迷宫节点。
- `GET /__event-horizon/archive/:token`：签名蜂蜜档案资源。
- `GET /__event-horizon/assets/black-hole.v1.js`：版本化 Canvas 渲染器与 Web Component，不进入行为计数。
陷阱与档案接口仅接受 `GET/HEAD`，其他方法返回 `405`；`HEAD` 只返回响应头，不写入遥测事件。

演示模式保留旧路径别名并提供内置 `robots.txt`。配置上游后，旧路径全部归还宿主，原站需在 `robots.txt` 中隔离 `/__event-horizon/`。

### 管理 API

- `GET /__event-horizon/admin/api/summary`：聚合指标。
- `GET /__event-horizon/admin/api/events`：最近 200 个匿名审计事件。
- `GET /__event-horizon/admin/api/baseline`：客户端类别 × 决策矩阵（仅观察模式校准用）。
- `POST /__event-horizon/admin/api/mode`：请求体 `{"mode":"labyrinth"}`。
- `POST /__event-horizon/admin/api/reset`：清空内存指标和页面缓存。

设置 `AIDG_ADMIN_TOKEN` 后需使用 `Authorization: Bearer ...`。未设置时，API 仅接受本机连接。

### `TrapVisit` 事件

```json
{
  "type": "trap_visit",
  "at": 0,
  "fingerprint": "带盐摘要",
  "session": "随机 ID",
  "node": "派生 ID",
  "depth": 2,
  "variant": "context",
  "cacheHit": false,
  "bytes": 12000
}
```

事件不包含原始 IP、完整请求头或页面提交内容。事件数组有固定上限，生产环境应替换为有保留期、访问控制和删除策略的审计存储。

蜂蜜档案另外产生 `archive_visit` 和 `archive_complete`，包含阶段、分片索引和序列是否完整，不保存解密内容或原始网络身份。

## 生产替换点

原型有三个明确的适配边界：

1. 机器人验证已内置标准 HTTP Message Signatures（RFC 9421 的 hmac-sha256 子集：`Signature-Input`/`Signature` 头，`keyid` 映射到 `AIDG_VERIFIED_BOTS` 密钥，与原型 HMAC 并存）。生产环境也可继续在 CDN/WAF 层验证，只把可信身份传给本服务。
2. 设置 `AIDG_SHARED_STATE_PATH` 后，多实例通过 JSON 文件共享匿名指纹与限速状态（参考实现：写入按 key 合并、限速标记立即落盘、LRU 淘汰不跨实例传播；被封禁记录在淘汰中固定）。边缘 Worker 部署目前为单 isolate 内存遥测。生产环境应替换为边缘 KV/Durable Object/集中审计流，适配接口与 `Map` 兼容（见 `src/shared-state.js`）。
3. 用仅观察模式（`AIDG_OBSERVE_ONLY=true`）收集真实基线：分类照常评分，响应永不修改，影子决策进入事件流，`GET /__event-horizon/admin/api/baseline` 输出客户端类别 × 决策矩阵。按站点、路径和机器人用途校准策略，不能直接照搬默认分数。
