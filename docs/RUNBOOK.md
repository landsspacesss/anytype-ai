# 运维手册 — Anytype `@ai` Bot

在自建 Anytype 网络里，`@anytype-bot` 或私聊它，它就会以完整 agent 身份回复，并能读写你空间里的对象。

---

## 1. 它由什么组成

```
┌────────────────────── 主机 (server) ──────────────────────┐
│                                                            │
│  [anytype 栈]  /home/landspace/anytype                     │
│    ├─ any-sync 节点们 (同步后端)                            │
│    └─ anytype-cli  ← 提供 HTTP API (127.0.0.1:31012)       │
│          ▲                                                 │
│          │ HTTP                                          │
│  [ai-bot 容器]  anytype-ai-bot:latest                      │
│    └─ node dist/main.js                                    │
│         • SSE 订阅每个聊天 → 收消息                         │
│         • 内嵌 pi SDK（同进程，无子进程）跑 agent           │
│         • 自带 Anytype 工具 / 文件工具                      │
│         • 回复写回聊天                                      │
│          │                                                 │
│          └─→ (网络) → deepseek 等模型 API                  │
└────────────────────────────────────────────────────────────┘
```

**关键点**：bot 容器用 `network_mode: service:anytype-cli` **共享 anytype-cli 的网络命名空间**——因为 anytype-cli 的 API 只绑容器回环，且校验 Host 头（用服务名访问会被 403）。所以 bot 必须经 `127.0.0.1:31012` 访问它。

| 东西 | 位置 |
|---|---|
| bot 源码 | `/home/landspace/anytype-ai-bot` |
| bot 运行配置 | `/home/landspace/anytype-ai-bot/.env`（**不提交**，含密钥） |
| bot 编排文件 | `docker-compose.bot.yml`（用"合并 compose"方式启动） |
| any-sync 栈 | `/home/landspace/anytype`（`docker-compose.yml`） |
| bot 长期状态 | Docker 卷 `bot_state` → 容器内 `/root/.pi/agent` |
| **每空间工作区/记忆** | Docker 卷 `bot_workspace` → 容器内 `/workspace/<spaceId>/` |

---

## 2. 日常操作

所有 `docker compose` 命令都要**两个 `-f` 合并**（因为 `service:anytype-cli` 只有在同一 compose 项目里才解析得到）。为方便，先设个别名：

```bash
alias aibot='docker compose -f /home/landspace/anytype/docker-compose.yml -f /home/landspace/anytype-ai-bot/docker-compose.bot.yml'
```

```bash
aibot ps                      # 看状态
aibot logs -f ai-bot          # 看实时日志
aibot restart ai-bot          # 重启
aibot stop ai-bot             # 停（数据保留）
aibot up -d ai-bot            # 起
```

> 容器设了 `restart: unless-stopped`：**主机重启、进程崩溃都会自动拉起**，一般不用手动管。

### 改代码后重新部署

```bash
cd /home/landspace/anytype-ai-bot
npm run build                 # 编译 TS → dist/
docker build -t anytype-ai-bot:latest .
cd /home/landspace/anytype
docker compose -f docker-compose.yml -f /home/landspace/anytype-ai-bot/docker-compose.bot.yml \
  up -d --force-recreate ai-bot
```

> 改了 `.env` 也要 `--force-recreate` 才会生效（env 是容器启动时读的）。

---

## 3. 让 bot 进入一个新空间

Anytype **没有"全局空间"**——成员是**逐空间**的。所以每个空间都得单独邀请 bot：

1. 在 Anytype 客户端打开目标空间 → **成员/Members → 邀请 → 生成邀请链接**
2. 在**服务器**上让 bot 加入：
   ```bash
   docker exec anytype-anytype-cli-1 sh -c "anytype space join '<邀请链接>'"   # 注意给链接加引号（含 #）
   ```
3. 客户端会收到**加入请求 → 批准**
4. 确认已加入：
   ```bash
   docker exec anytype-anytype-cli-1 anytype space list
   ```
5. **重启 bot** 让它发现新空间：`aibot restart ai-bot`

> API key 是 `--all-spaces` 的，覆盖 bot 所在的**所有**空间（含以后加入的），**不用改 key**。
>
> bot 在每个空间里有个**独立的成员 id**（`_participant_<spaceId>_<identity>`）。这个由程序自动按身份解析，你**不用手动填**。

---

## 4. 换模型 / 换 provider

bot 用**内嵌的 pi SDK**，pi 自动识别常见的 provider 环境变量。编辑 `.env`：

```bash
DEEPSEEK_API_KEY=sk-...      # 当前用的
# 或 ANTHROPIC_API_KEY=...   # 换个 provider 就换成它的变量
```

然后 `docker compose ... up -d --force-recreate ai-bot`。

> 当前用的是 **deepseek**（`deepseek-v4-pro`，pi 依 provider 自动选）。换 provider 只需改 `.env` 里对应的 key 变量，无需改代码。

---

## 5. 记忆（按空间）

记忆是**每个空间一份**，就是工作区里的两个文件：

| 文件 | 作用 |
|---|---|
| `/workspace/<spaceId>/AGENTS.md` | **给 AI 的指令**：告诉它"你是 Anytype 里的助手"、要主动记笔记、怎么用工具。pi 启动时会自动加载。 |
| `/workspace/<spaceId>/MEMORY.md` | **AI 自己写的长期笔记**（"记住X"→ 写这里；下次对话先读它）。 |

查看某空间的记忆：
```bash
docker exec anytype-ai-bot-1 cat /workspace/pqdthe/MEMORY.md
```

**改提示词**（比如调整记忆策略、身份描述）：改 `src/agent/pi-session.ts` 里 `ensureAgentFiles()` 的模板 → 重新部署。注意它**只在 AGENTS.md 不存在时才写**，已存在的空间需手动更新：
```bash
docker exec anytype-ai-bot-1 sh -c 'cat > /workspace/pqdthe/AGENTS.md' < 新模板.md
```

---

## 6. bot 有哪些能力

| 工具 | 作用 |
|---|---|
| `anytype_list_objects` | 列出当前空间的对象（**已过滤聊天/系统对象**） |
| `anytype_search` | 按文本搜空间内容 |
| `anytype_read_object` | 读某篇的标题和正文 |
| `anytype_create_note` | 新建页面 |
| pi 内置 | 读写文件、跑命令、搜索等（完整 agent） |

**触发规则**：被 `@anytype-bot` 时回复；**私聊**（成员 ≤2 的聊天）里每条都回；bot 自己的消息永不触发。

---

## 7. 排障

| 现象 | 原因 / 处理 |
|---|---|
| 日志 `fatal: listSpaces failed: 401` 后自动恢复 | anytype-cli 重启时的瞬时鉴权失败，容器会自动重启；忽略即可。若反复出现，见下条。 |
| 反复 401 / 连不上 API | `docker ps` 看 anytype-cli 是否健康；`aibot restart ai-bot`。 |
| 日志里 `oom ready timeout` | **已废弃**（那是旧 omp 时代的错误）。若还出现说明跑的是旧镜像，重建。 |
| 收到消息但长时间不回复、无反应 | ① 看 `aibot logs ai-bot` 有无报错；② 消息是否比 bot 启动时间早（订阅时会跳过历史回放）；③ 重启 bot（刷新 SSE 订阅）。 |
| 问"笔记"它去翻本地文件 | 应调 `anytype_*` 工具。检查 `AGENTS.md` 是否有身份提示段，以及它是否在 bot 所在空间里。 |
| 回复很慢（分钟级） | 那是旧 omp 架构。当前是内嵌 pi SDK，正常 **几秒**。 |
| 内存 | 正常空闲 ~70–100MB；上限 2G。看 `docker stats anytype-ai-bot-1`。 |
| 容器停了 | `docker ps -a` 看退出码；`restart: unless-stopped` 一般会自动拉起。 |

---

## 8. 关键常量（速查）

| 项 | 值 |
|---|---|
| bot 账号身份 | `A7D1kUBFSFfs7jBbTgFZ2uvp2Eo2eSpZWpjt52X41rMqZHPm` |
| bot 显示名 | `anytype-bot` |
| anytype-cli API | `http://127.0.0.1:31012`（容器内经共享 netns；主机经 `127.0.0.1:31012`） |
| anytype-cli 容器 | `anytype-anytype-cli-1` |
| bot 容器 | `anytype-ai-bot-1` |
| 测试空间 | `考试`（API id `pqdthe`） |

---

## 9. 从零重建（灾难恢复）

1. 起 any-sync 栈（含 anytype-cli）：见 `/home/landspace/anytype` 的说明；`anytype-cli` 两段服务已在 `docker-compose.yml` 中启用。
2. 建 bot 账号 + key：
   ```bash
   docker exec anytype-anytype-cli-1 anytype auth apikey create ai-bot --all-spaces --read-write
   ```
   把得到的 key 填进 `.env` 的 `ANYTYPE_API_KEY`。
3. 让 bot 加入各空间（见第 3 节）。
4. 把 `.env` 其余项填好（身份、provider key）。
5. 构建并启动（见第 2 节）。

> 记忆存在 Docker 卷 `bot_workspace` 里，只要卷还在就不会丢。
