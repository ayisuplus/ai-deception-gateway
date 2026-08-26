# AI Deception Gateway

一个以黑洞为视觉隐喻的 AI 爬虫诱捕与成本放大趣味实验。它把请求统一分类为 `allow / observe / tarpit / block`，向可疑爬虫提供一次性签名迷宫或分层“蜂蜜档案”，并把深入路径表现为逐渐增强的事件视界。

这个项目不是传统 WAF 的替代品，也不会尝试在前端隐藏秘密。账户、交易、客户和内部系统数据仍然必须通过服务端授权保护。

## 立即运行

需要 Node.js 22 或更高版本，不需要安装第三方依赖。

```powershell
npm start
```

然后访问：

- 事件视界实验室：<http://127.0.0.1:8787/__event-horizon/>
- 受保护的公开内容：<http://127.0.0.1:8787/content/research>
- 防御控制台：<http://127.0.0.1:8787/__event-horizon/admin>
- 健康检查：<http://127.0.0.1:8787/__event-horizon/health>

未配置上游时，原来的 `/`、`/admin`、`/health` 和动画资源路径仍可作为演示兼容别名。

运行测试和完整对照实验：

```powershell
npm test
npm run benchmark
node benchmark/run.js --json=benchmark-results.json
```

## 已实现能力

- 五种实验模式：无防御、内联噪声、链接迷宫、上下文迷宫、蜂蜜档案。
- HMAC 签名、带有效期且无数据库状态依赖的迷宫 URL。
- 蜂蜜档案采用签名清单、4 个 SHA-256 内容寻址密文分片、Merkle 根、3 段 XOR 密钥和 AES-256-GCM 完整性验证。
- 正确但与金融无关的内置科学事实；没有外部链接、虚假金融信息或提示注入，仅允许固定同源视觉脚本。
- 零依赖 Canvas 2D 黑洞：星空、光子环、吸积盘、简化引力透镜和迷宫深度联动。
- `noindex / nofollow / noarchive / nosnippet` 搜索隔离和严格 CSP。
- 匿名化访问指纹、迷宫深度、缓存状态、决策理由和封禁事件。
- 达到迷宫配置深度后自动限速；默认迷宫深度为 4。
- 标准 HTTP Message Signatures（RFC 9421 子集）机器人验证，以及仅观察基线模式（决策矩阵见 `/admin/api/baseline`）。
- 可选文件后端共享指纹存储，多实例之间传播限速状态。
- 反向 CTA 验证门实验：测量自动化客户端跟随最大按钮还是页面文字。
- 面向非技术使用者的实时防御控制台。
- 可选固定上游站点代理，用于保护真实的公开 HTML 内容。
- 边缘函数包：同一请求核心可作为 Cloudflare Worker 部署（`edge/`），源站零改动即插即用。
- Connect/Express 中间件：`createGatewayMiddleware` 一行嵌入（`app.use(...)`），宿主应用零改动。
- 可嵌入的 `<event-horizon-visual>` Web Component，使用 Shadow DOM 隔离并支持运行时场景更新。
- 五种评测客户端：守规爬虫、递归爬虫、过滤爬虫、确定性的上下文压缩代理模拟器和真实执行档案校验/解密的解析器。

蜂蜜档案里的“加密”不是保密措施：解密所需的全部碎片都故意留在站内，目的是让愿意深挖的自动化客户端暴露更多可审计行为，并提高下载、校验和解析成本。真正的内容保持原样，任何秘密仍然只能放在服务端授权之后。

## 事件视界视觉

首页使用全屏 Canvas 展示交互式黑洞。签名迷宫页把服务端 `depth` 映射为 `0.2–1.0` 的视觉强度：路径越深，黑洞越大、光子环和透镜越明显；被限制时显示完整事件视界。动画只是观察者看到的项目叙事，不假设普通 HTTP 爬虫会执行 Canvas，也不参与流量分类或访问控制。

视觉层不使用图片、字体、WebGL 或第三方库，只加载长期缓存的 `/__event-horizon/assets/black-hole.v1.js`。CSP 限制为固定同源脚本且 `connect-src 'none'`，动画无法发起网络请求；减少动态效果的系统设置会自动切换为静态画面。

同一个资源还会注册 `<event-horizon-visual>`。站长可以把黑洞作为独立组件嵌入宿主页面，普通页面不会被网关自动加上动画。完整的 Nginx 路由、CSP 和组件示例见 [单站接入指南](./docs/EMBEDDING.md)。

## 请求决策

| 决策 | 行为 |
|---|---|
| `allow` | 原样返回正式内容 |
| `observe` | 原样返回并记录低置信度自动化信号 |
| `tarpit` | 按当前实验模式返回正式内容和诱捕入口，或实验噪声 |
| `block` | 返回 `429`，不继续提供内容 |

机器人身份验证优先于启发式分类。网关内置两种机制：标准 HTTP Message Signatures（RFC 9421 的 hmac-sha256 子集）和便于本地测试的原型 HMAC 协议；两者共用 `AIDG_VERIFIED_BOTS` 密钥映射。生产接入时优先使用标准签名，也可在 CDN/WAF 层验证后再把可信身份传给本服务。

标准签名使用 `Signature-Input` 与 `Signature` 头，`keyid` 对应机器人 ID；覆盖组件支持 `@method`、`@path`、`@authority` 等派生组件和任意请求头字段。验证方强制两条反重放策略：必须覆盖 `@method` 与 `@path`（否则一个签名全站通用），且必须携带 `created`（±5 分钟窗口，`expires` 如存在即执行）。可参考 [src/security.js](./src/security.js) 中的 `signMessageRequest` 和 `verifyMessageRequest`。

原型签名绑定：请求方法、路径与查询串、毫秒时间戳和机器人 ID。请求头为：

- `X-AIDG-Bot-Id`
- `X-AIDG-Timestamp`
- `X-AIDG-Signature`

可参考 [src/security.js](./src/security.js) 中的 `signBotRequest` 和 `verifyBotRequest`。

## 配置

| 环境变量 | 默认值 | 用途 |
|---|---:|---|
| `PORT` | `8787` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址 |
| `AIDG_MODE` | `labyrinth` | 五种实验模式之一 |
| `AIDG_ORIGIN_URL` | 空 | 固定的 `http/https` 公开上游站点 |
| `AIDG_TOKEN_SECRET` | 启动时随机 | 迷宫令牌密钥；多实例和重启场景必须固定 |
| `AIDG_FINGERPRINT_SALT` | 启动时随机 | 匿名访问指纹盐值 |
| `AIDG_VERIFIED_BOTS` | `{}` | `{"bot-id":"至少16字符密钥"}` JSON 对象 |
| `AIDG_ADMIN_TOKEN` | 空 | 控制台 API 凭证；为空时只允许本机调用 |
| `AIDG_AUTO_BLOCK` | `true` | 是否按迷宫深度自动限制 |
| `AIDG_AUTO_BLOCK_DEPTH` | `4` | 自动限制深度 |
| `AIDG_BRANCH_FACTOR` | `3` | 每个迷宫节点的分支数 |
| `AIDG_TOKEN_TTL_SECONDS` | `3600` | 签名入口有效期 |
| `AIDG_DEBUG_HEADERS` | `false` | 是否暴露实验决策头；生产保持关闭 |
| `AIDG_OBSERVE_ONLY` | `false` | 仅观察模式：照常评分但永不修改响应，影子决策进入遥测 |
| `AIDG_SHARED_STATE_PATH` | 空 | 多实例共享指纹状态的 JSON 文件；为空使用进程内存 |
| `AIDG_REVERSE_CTA_GATE` | `false` | 迷宫深度页追加反向 CTA 验证门实验 |
| `AIDG_TRUST_FORWARDED_FOR` | `true` | 是否信任 X-Forwarded-For；非受信代理部署设为 `false` |

上游代理刻意不转发 Cookie 和 Authorization，仅适用于公开 `GET/HEAD` 内容。被修改的 HTML 强制私有且不缓存，防止诱饵污染共享缓存；登录、表单、上传、交易和 API 必须在前置路由层绕过本服务。未配置 `AIDG_ORIGIN_URL` 时，服务使用内置研究页演示完整流程。
## 边缘部署（Cloudflare Workers）

请求核心与运行时解耦：`src/core.js` 是标准 `fetch(Request) → Response`，`src/app.js` 只是 node:http 适配器。同一个核心可直接作为 Worker 部署在 CDN 层，源站一行代码都不用改：

```powershell
cd edge
wrangler secret put AIDG_TOKEN_SECRET      # 固定随机值；跨 isolate 必须一致
wrangler secret put AIDG_FINGERPRINT_SALT
wrangler secret put AIDG_ADMIN_TOKEN
# 在 edge/wrangler.toml 的 [vars] 中设置 AIDG_ORIGIN_URL 与 AIDG_MODE
wrangler deploy
```

然后在 Cloudflare 仪表盘把站点路由到该 Worker。注意事项：

- 需要 `nodejs_compat`（网关使用 node:crypto）和 wrangler.toml 里的 Text 资源规则，均已配置。
- 遥测为单 isolate 内存：限速标记暂不跨 isolate 传播；KV/Durable Object 适配是下一个替换点。
- Worker 环境必须固定 `AIDG_TOKEN_SECRET`，否则各 isolate 签名互不信任，陷阱链接全部失效。

## 作为中间件嵌入（Express / Connect）

自控应用服务器时，护盾是一行中间件：

```js
import express from "express";
import { createGatewayMiddleware } from "ai-deception-gateway/middleware";

const app = express();
app.use(createGatewayMiddleware({
  mode: "labyrinth",
  tokenSecret: "稳定的随机值",
  fingerprintSalt: "另一个稳定的随机值",
  adminToken: "管理凭证",
}));
```

行为约定：

- 只接管 `/__event-horizon/` 命名空间（迷宫、蜂蜜档案、控制台、资产、健康检查）和对所有路径的封禁闸；其余请求原样 `next()`。
- 可疑（tarpit）客户端的 HTML 响应在 `</body>` 前注入签名入口；被修改的响应改为 `private, no-store` 并移除 `ETag`；非 HTML 与正常客户端逐字节透传。
- 宿主路由的请求体从不被读取；`AIDG_*` 环境变量依然生效，显式参数优先。

## 当前实测结果

本机确定性基准中：

- 递归爬虫在两种迷宫下达到 `24×` 请求量。
- 上下文代理模拟器达到 `7×` 请求量；加入规范化路径和可嵌入渲染器后，基础迷宫约 `20.86×`、上下文迷宫约 `25.41×` 估算令牌量。
- 守规爬虫和过滤爬虫均未进入迷宫。
- 蜂蜜档案让递归爬虫、上下文代理和档案解析器形成 `11×` 请求路径；三者都能通过 Merkle 校验并完成 AES-GCM 解密，证明成本来自真实协议步骤而不是装饰性字符串。
- 蜂蜜档案解密结果只含内置安全科学事实、合成数据声明和单会话 `HONEY-*` 金丝雀；守规爬虫与过滤爬虫进入档案次数为 0。
- 所有客户端仍能正确提取公开正文，因此该系统实现的是识别和增本，不是假装公开内容不可获取。
- 上下文迷宫的模拟压缩探针召回为 `60%`；基础迷宫为 `100%`。这只证明实验装置能够观测压缩差异，不构成跨模型结论。

完整方法和验收边界见 [docs/VALIDATION.md](./docs/VALIDATION.md)。

## 生产安全边界

- 不对正常浏览器和已验证机器人注入任何内容；集成测试会逐字节比较正式正文。
- 不依赖 User-Agent 作为可信身份；它只提供低置信度分类信号。
- 不在诱饵中放置操作指令、凭据请求、外部链接或金融事实；唯一脚本是无网络能力的同源 Canvas 渲染器。
- 加密包装只用于诱捕与测量，不被描述为内容保护；全部密钥碎片公开可取回，解密结果不包含秘密。
- 不尝试污染对方训练集、长期记忆或控制站外行为。
- 不记录原始 IP；事件只保留带盐摘要和粗粒度客户端类别。
- 隐藏入口可能带来 SEO、无障碍与当地法律问题，上线前必须完成专项审查。
- 误伤率 `<0.1%` 尚不能由合成流量证明，需要在仅观察模式下使用真实流量完成校准。
- “上下文压缩策略跨三种真实代理稳定生效”尚未通过，因此该部分仍是研究模块。

架构和事件流详见 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)。
