# 单站接入与 Web Component

## 接入边界
如果站点已经在 Cloudflare 上，有一条零源站改动的替代路径：`edge/` 中的 Worker 包把同一请求核心部署在边缘，公开内容经 Worker 代理，迷宫与档案由 Worker 直接回答，不需要本节的前置路由拆分。详见 README 的“边缘部署”一节。

事件视界网关只接收公开、无凭据的 `GET/HEAD` 内容。登录、Cookie 个性化页面、表单、上传、交易和私有 API 必须由前置 CDN 或反向代理直接送往原站。即使浏览器把 Cookie 或 Authorization 发到了公开路径，网关也不会把它们转发给上游。

每个实例只保护一个固定上游：

```powershell
$env:AIDG_ORIGIN_URL = "http://127.0.0.1:8080/"
$env:AIDG_TOKEN_SECRET = "replace-with-a-stable-random-secret"
$env:AIDG_FINGERPRINT_SALT = "replace-with-a-different-stable-secret"
$env:AIDG_ADMIN_TOKEN = "replace-with-an-admin-token"
npm start
```
多实例保护同一站点时，再设置 `AIDG_SHARED_STATE_PATH` 指向同一个 JSON 文件以共享限速状态；更大规模部署应替换为边缘 KV。上线初期建议 `$env:AIDG_OBSERVE_ONLY = "true"`：仅观察模式照常评分但永不修改响应，用 `GET /__event-horizon/admin/api/baseline` 的决策矩阵校准阈值，确认误入率后再切回诱捕模式。
网关默认信任 `X-Forwarded-For`（适配 CDN/反代拓扑）。若网关可能暴露在未受信网络，设置 `$env:AIDG_TRUST_FORWARDED_FOR = "false"`，否则访客可伪造来源地址轮换匿名指纹、规避限速；前置代理也应覆盖而不是透传客户端的 `X-Forwarded-For`。

配置上游后，网关只保留 `/__event-horizon/` 命名空间。宿主的 `/`、`/admin`、`/health` 和 `/assets/*` 都会正常代理到原站。

## 前置路由示例

推荐在 Nginx、CDN 或负载均衡器上按路径区分公开内容和敏感功能。下面示例把实验接口和公开文章交给网关，其他流量直接送回原站：

```nginx
upstream event_horizon_gateway {
    server 127.0.0.1:8787;
}

upstream application_origin {
    server 127.0.0.1:8080;
}

location ^~ /__event-horizon/ {
    proxy_set_header Host $host;
    proxy_pass http://event_horizon_gateway;
}

location ^~ /articles/ {
    proxy_set_header Host $host;
    proxy_pass http://event_horizon_gateway;
}

location / {
    proxy_set_header Host $host;
    proxy_pass http://application_origin;
}
```

不要把登录、API 或提交路径放入网关路由。部署后使用 `GET /__event-horizon/health` 做存活检查，并在原站的 `/robots.txt` 中加入：

```text
User-agent: *
Disallow: /__event-horizon/
```

## 嵌入黑洞组件

动画脚本由同一个站点提供，不依赖第三方资源：

```html
<script defer src="/__event-horizon/assets/black-hole.v1.js"></script>

<event-horizon-visual
  scene="home"
  depth="0"
  intensity="0.58"
  aria-label="事件视界互动视觉">
</event-horizon-visual>
```

用宿主 CSS 控制尺寸和外观：

```css
event-horizon-visual {
  display: block;
  width: min(100%, 960px);
  min-height: 320px;
  margin: 2rem auto;
  border-radius: 24px;
  box-shadow: 0 28px 80px rgb(0 0 0 / 35%);
}
```

组件属性：

| 属性 | 值 | 默认行为 |
|---|---|---|
| `scene` | `home`、`trap`、`blocked` | `home` |
| `depth` | 大于等于 0 的整数 | `0` |
| `intensity` | `0` 到 `1` | 省略时由 `depth` 映射 |

属性可以在运行时修改，画面会立即更新。组件初始化完成后会设置 `data-black-hole-ready="true"`。它使用 Shadow DOM 隔离内部 Canvas，不读取宿主正文、不拦截点击和滚动，也不发起网络请求。

宿主 CSP 至少需要允许这一个同源外部脚本，例如 `script-src 'self'`，也可以配置允许精确的脚本 URL。未执行 JavaScript 时，宿主正文和全部链接仍然可用；组件区域只是不显示动画。

## 安全与缓存

- 正常和已验证访问保留上游正文及缓存语义。
- 被修改的诱饵 HTML 强制使用 `Cache-Control: private, no-store`，不会进入共享缓存。
- 非 UTF-8 HTML、非 HTML、下载和错误响应不注入诱饵。
- 上游绝对同源重定向会改写成当前站点路径；站外重定向保持不变。
- 网关页面禁止 iframe 嵌套；对外嵌入只使用 Web Component。
- 上游不可用时返回通用 `502 Gateway Error`，不会暴露内部上游地址。
