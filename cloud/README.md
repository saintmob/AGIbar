# Cloudflare 公共模型工作台

`cloud/public/` 为静态公共站点。MiniMax H3 与 Kimi K3.1 Pro 各有模型页签，每个页签均提供「健康探测 → Playground → 本地配置提示词」三个功能区。顶部接入配置预填 H3 endpoint、Kimi Base URL / 模型、共享店内 key 与 Bearer 认证。自动监测、通知、检测间隔及监测状态持久化均已移除；刷新不会发起任何 API 请求，并清理旧的监测存储。

## 接入与数据边界

按用户授权，公开预填店内接入 key `sk-agi_bar-static`。这是访客可见的公开接入信息，存在于源码、localStorage、浏览器请求和复制的本地配置提示词中，请勿填入私人密钥。站点可公开访问，真实 API 仅限店内网络，由访客浏览器直连 `https://token.agi.bar`。访问限制由上游控制，本站未实现或验证 IP 门禁；额度与策略以上游为准，不承诺无限额度。

Cloudflare 仅托管静态资源，无 API 代理、Secret、数据库、KV / D1 / R2。配置、主题、选中页签、最近 10 条 H3 任务以及 Kimi 输入与最近一次回复仅保存于当前 origin 的 localStorage。不同浏览器互不共享，同浏览器同 origin 标签页共享存储，无跨标签执行锁。清理站点数据或禁用存储后无法恢复记录。

## 健康探测与协议

- H3 使用一次带 Bearer 的 `HEAD` 请求，最多等待 15 秒，不提交视频生成参数。仅报告连接与 HTTP 状态；即使返回 2xx，也不能证明生成可用，405 / 401 等表示收到响应。无自动重试。上游可能不允许 HEAD 或所需 CORS，网络 / CORS / 超时无法仅从浏览器可靠区分。
- Kimi 使用一次 `POST /v1/chat/completions`：`model: k3.1-pro`、消息 `Hi`、`max_tokens:1`、`stream:false`。可能消耗额度。2xx 且无 error 并含 `choices[].message` 才显示可用，50 秒与 64 KiB 限制。不会自动检测或通知。
- H3 Playground 是浏览器 `fetch + FormData` 的同步视频请求，不运行 curl，无法强制 HTTP/1.1。该店内链路已观察到 HTTP/2 故障，浏览器生成路径不保证成功；请求预览与本地配置明确提供 `curl --http1.1 --fail-with-body`，供本地终端 / agent 使用。
- Kimi Playground 是单轮、非流式 Chat Completions，用户填写提示词与最大输出 Tokens（1–4096，为本站保护限制，不代表上游支持全部组合）。最多等待 50 秒，响应上限 64 KiB；只保存最近成功回复，不自动重发。取消不保证上游停止处理或计费。
- 两类请求均固定 HTTPS 上游、不跟随重定向；CSP 限定连接 token.agi.bar。需上游允许 Authorization 等 CORS 请求。Main 先前确认过 Kimi OPTIONS 允许站点 Origin，真实 H3 HEAD/生成与 Kimi 对话仍需店内网络验收。

## 视频与本地配置限制

H3 最长等待 20 分钟、响应上限 48 MiB；HTTP 2xx 加 MP4 `ftyp` 才可下载，错误展示前 64 KB。完整 key 回显会阻止视频 / 对话展示与保存。视频不超过 2 MiB 时尝试缓存，容量不足时仅保留历史；大视频仅当前页面 Blob URL 可下载。刷新中断同步连接，将运行历史标为中断，不会重发；取消不保证上游停止生成或计费。

各模型的复制入口使用当前访客配置 key。H3 提示词明确其为视频模型，不可替代 coding / chat 模型，要求使用 curl 强制 HTTP/1.1。Kimi 提示词要求检查目标工具的 Chat Completions 兼容性；Codex / Claude 原生协议不保证直接兼容，新增桥接须先说明。仅复制文本不会安装、配置或调用 API。

## 本地检查与部署

无需构建，无 runtime 依赖。旧 `node server.mjs` 与 `public/` 保留为独立本地 curl 工作台，其旧版监测功能不属于公共站点。

```sh
node --test test/*.test.mjs
node --check cloud/public/app.js
node --check cloud/public/protocol.js
pnpm dlx wrangler dev
pnpm dlx wrangler deploy --dry-run
```

`wrangler.jsonc` 仅发布 `cloud/public`，包含 `agibar.lllllll.uk` 自定义域名。部署由 Main 执行，本 Candidate 仅 dry-run，无实际部署。无需 API Secret；Cloudflare 账户授权用于发布静态资源。

## 验收范围

`test/cloud-ui.test.mjs` 执行实际 app.js 的 VM 测试：模型三功能结构、迁移旧监测状态、刷新不发请求、H3 HEAD / HTTP 诚实判定、Kimi 最小探测、各模型配置复制使用当前 key、对话请求与本地恢复、敏感回显阻断、页面关闭中止。

`test/cloud-protocol.test.mjs` 验证固定协议、multipart、参数、响应上限、MP4、key 回显和静态 CSP。原本地工作台测试保留。所有测试使用本机模拟，不消耗真实额度；真实跨域、视频生成与浏览器视觉验收交 Main / Verifier。
