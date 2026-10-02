# anytype-ai

**在 Anytype 中引入类 Notion 的 AI 助手。**

Anytype 是一个很棒的、私密的、本地优先的 Notion 替代品——但**它没有 AI**。
`anytype-ai` 补上这一块：一个住在**你自建 Anytype 里**的 `@ai` 助手。在任意聊天里
@ 它（或私聊它），它就回复——背后是一个完整 agent：能读、搜、写、改你的笔记，
能看图、读文件、联网搜索，还能按计划定时检查。相当于"Notion AI"，但跑在
**你自己的服务器**、走**你自己端到端加密的网络**上。

> English docs: [README.md](README.md)

## 它能做什么

- **聊天** —— 回复是**纯文本**（聊天里不塞 Markdown）。
- **笔记** —— 列 / 搜 / 读 / 建 / 改 / 删 页面、块、标签、属性、类型、集合、模板。
- **看图** —— 读页面里的图片（缩放后发给多模态模型）；可下载 + 裁剪放大看扫描件/手写。
- **读任意散文件** —— 下载 PDF / docx / xlsx / txt，用 shell 工具（`pdftotext`/`unzip`/`python3`）抽内容。
- **联网** —— `web_search`（托管搜索）和 `web_fetch`（内置 [Lightpanda](https://github.com/lightpanda-io/browser) 无头浏览器，返回 Markdown）。
- **记忆** —— 每个空间一份 `MEMORY.md`，AI 会主动记录。
- **定时订阅** —— 按 cron 订阅某个对象，它一变就让 AI 执行你的指令（如"总结变化"）并发回。
- **子代理** —— 一次性 `subagent`；以及常驻命名子代理（`agent` 的 spawn/message/list/kill），可跨轮对话。
- **聊天指令** —— `/new` `/clear` `/compact` `/model` `/effort` `/yolo` `/help`。
- **对话持久化** —— 每个聊天的历史重启不丢。

## 架构 —— 这是一个**独立服务**

`anytype-ai` 是**独立于你 Anytype 服务端的一个服务**，就是**一个小容器**，通过本地
HTTP API 跟你的 Anytype 栈通信。它**不属于** `any-sync` / `any-sync-dockercompose`，
也不会改动它。

```
┌──────────── 你的 Anytype 栈（分开的）────────────┐
│  any-sync 节点 …  +  anytype-cli（本地 HTTP API :31012）│
└────────────────────────▲──────────────────────────┘
                         │ HTTP/SSE + API key
┌────────────────────────┴──────────────────────────┐
│  anytype-ai（本项目 —— 一个容器）                   │
│    bridge + 内嵌 pi agent  →  你的模型 API（如 DeepSeek）│
└────────────────────────────────────────────────────┘
```

唯一的耦合点是 Anytype 那边**一个设置**：在你的 any-sync compose 里
**启用 `anytype-cli` 服务**（它提供 bot 用的 HTTP API）。本项目只提供 bot 自己的
`docker-compose.bot.yml`。

## 前置条件

- Docker + Docker Compose v2。
- 一套跑着的自建 Anytype 网络，且**已启用 `anytype-cli`**（本地 HTTP API，端口 31012）。
  见 any-sync-dockercompose 文档。
- 一个模型 API key。默认用 **DeepSeek**（`web_search` 也用它）。
- 仅在**不用 Docker** 时才需要 Node 22。

## 快速开始

```bash
git clone https://github.com/landsspacesss/anytype-ai anytype-ai
cd anytype-ai
cp .env.example .env      # 然后按需编辑（见下）
npm install && npm run build
docker build -t anytype-ai-bot:latest .
```

启动时**合并进你的 any-sync compose 项目**（这样共享网络命名空间才解析得到
`network_mode: service:anytype-cli`）：

```bash
cd /path/to/any-sync-dockercompose
docker compose -f docker-compose.yml -f /path/to/anytype-ai/docker-compose.bot.yml \
  up -d --no-deps ai-bot
```

然后在 Anytype 客户端里，**把 bot 账号邀请进某个空间**，并给它 **Editor** 角色
（Viewer 发不了消息）。

## 配置（`.env`）

| 键 | 含义 |
|---|---|
| `ANYTYPE_API_BASE_URL` | Bot 的 HTTP API 地址（默认 `http://127.0.0.1:31012`） |
| `ANYTYPE_API_KEY` | bot 的 Anytype 账号 API key |
| `BOT_IDENTITY` | bot 账号的稳定身份（其 participant id 随空间变） |
| `BOT_DISPLAY_NAME` | 显示名，用于剥离 `<mention>` 标签 |
| `DEEPSEEK_API_KEY` | 模型 key（agent + `web_search`） |
| `PI_MODEL` / `SEARCH_MODEL` | 模型 id（默认 `deepseek-flash`，V4.1 多模态） |
| `MAX_CONCURRENT_SESSIONS`、`IDLE_REAP_MS` | 每聊天会话池 |
| `WATCH_TICK_MS`、`WATCH_DEFAULT_CRON`、`WATCH_MAX_MISSES` | 定时订阅 |
| `TZ` | cron 按此时区评估（如 `Asia/Shanghai`） |
| `SESSION_PERSIST` | 设为 `false` 关闭对话历史持久化 |
| `MAX_SUBAGENTS`、`SUBAGENT_IDLE_MS` | 命名子代理池 |
| `LIGHTPANDA_BIN`、`WEB_FETCH_TIMEOUT_MS`、`WEB_FETCH_MAX_CHARS` | `web_fetch` |

## 开发

```bash
npm install
npm run build     # tsc
npm test          # vitest（290 个测试）
```

运维细节见 [`docs/RUNBOOK.md`](docs/RUNBOOK.md)（部署、加空间、换模型、状态存放位置、排障）。

## 许可

Apache-2.0（见 [`LICENSE`](LICENSE)）。三方声明见 [`NOTICE`](NOTICE)——
注意 **Lightpanda 是 AGPL-3.0**，它在**构建时下载、并不打包进本仓库**。
