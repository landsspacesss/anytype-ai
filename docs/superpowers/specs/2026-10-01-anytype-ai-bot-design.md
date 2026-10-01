# Anytype `@ai` Bot — 设计文档

- 日期：2026-10-01
- 状态：设计已与用户逐节确认，待编写实施计划
- 项目位置：`/home/landspace/anytype-ai-bot`
- 依赖的既有部署：自建 Anytype 后端 `any-sync-dockercompose`（`/home/landspace/anytype`，MIT）

## 1. 背景与目标

Anytype 没有内置 AI——"在客户端内 @AI 让它回复"不是原生功能。但底层条件齐备：一个 bot/API 账号加入空间后即为空间成员，**可以被 @**；本地 API 支持实时事件流（SSE / gRPC）；API 能发送消息。

本项目自建这个能力：一个 bot 账号作为空间成员，用户 **@ 它** 或 **私聊它**，触发一个具备**完整 agent 能力**的 AI（能跑命令、改文件、读写 Anytype 对象）生成回复，**回复直接发回 Anytype 聊天**。

## 2. 需求（已确认）

| # | 需求 | 决定 |
|---|---|---|
| R1 | bot 身份 | 空间成员，可被 @ / 可私聊 |
| R2 | 能力范围 | 完整 agent（跑命令、改文件、操作 Anytype），运行在**独立容器** |
| R3 | 隔离 | **严格隔离**：容器只有自己的临时工作区 + 网络访问，碰不到主机文件 |
| R4 | 大脑 | **omp**（Oh My Pi，pi 的 fork） |
| R5 | 模型 | 可切换（首版先跑通，不锁定 provider） |
| R6 | 全局记忆 | 跨所有会话共享；由**模型自己整理**（mnemopi，`scoping=global`，`llmMode=smol`） |
| R7 | 会话划分 | 按 `chat_id` 区分；页面讨论与主聊天**天然是不同 chat**，无需额外逻辑 |
| R8 | 触发 | 聊天内**被 @** 才回；**私聊每条都回**；bot 自己发的消息**永不触发** |
| R9 | 忙时 | **按序排队**（每条消息 = 一个 prompt） |
| R10 | 并发 | 常驻 omp 进程总数上限 **3**，超出排队 |

### 明确不做（Out of scope）

- 流式"打字机"效果回帖（Anytype 消息是整条发送，无法原地更新）——首版等 `agent_end` 后一次性发
- 账号级统一事件流（HTTP v2 只有 per-chat SSE；见 §10 风险）
- 多租户 / 多空间权限体系（个人自用）
- 全自动 E2E 测试（依赖真实网络与多进程，易 flaky）

## 3. 架构

```
┌─────────────────────── 主机 (server) ───────────────────────┐
│                                                              │
│  [any-sync 栈]  (已运行)                                      │
│    ├─ coordinator / node×3 / filenode / consensus / garage… │
│    └─ anytype-cli ★新增★   暴露 HTTP API:31012 + gRPC:31010 │
│          ▲                                                   │
│          │ HTTP + SSE (检测 @/私聊、发回复)                    │
│          │                                                   │
│  [agent 容器] ★新增★  debian-slim, 严格隔离                   │
│    ├─ bridge (Node): EventSource/Router/OmpClient/ReplySink  │
│    └─ omp --mode rpc  (子进程, stdio 逐行 JSON, 每 chat 一个) │
│          │                                                   │
│          └─ (网络) → LLM provider + anytype-mcp 工具          │
│                                                              │
│  [持久卷] bridge+omp 的 sessions / memories / config          │
└──────────────────────────────────────────────────────────────┘
```

### 三个部件

| 部件 | 职责 | 依赖 |
|---|---|---|
| **anytype-cli** | bot 的"替身账号"——登录、加入空间、收发消息、暴露 HTTP/gRPC API | any-sync 栈 |
| **bridge** | 监听 Anytype 事件 → 判定触发 → 派给 omp → 把回复发回聊天 | anytype-cli API |
| **omp** | 大脑：收到 prompt，跑 agent 循环（可调工具），产出回复 | LLM provider |

### 设计要点

- **bridge 与 omp 同容器**：omp RPC 是 stdio 协议，bridge 必须能 spawn 它作子进程；跨容器做不到（除非加 stdio↔TCP shim，徒增部件）。隔离以**整个容器**为边界。
- **进程模型**：omp RPC 是逐行 JSON over stdio，且**一个进程只能管一个会话**。因此 **每个活跃 chat = 一个常驻 omp 进程**，由 bridge 惰性拉起、闲置回收。conversation 之间上下文天然隔离。

## 4. 组件与接口

bridge 内部四个模块，边界清晰、可独立测试：

```
[EventSource]  —— 订阅 anytype-cli 事件流
      │ 规范化: {spaceId, chatId, senderId, text, mentionsBot, isBotSelf}
      ▼
[Router]       —— 判定是否触发 + 找/拉起对应 omp 进程
      │ {chatId, prompt}
      ▼
[OmpClient]    —— 管一个 omp 子进程的完整生命周期
      ▲
      │ text_delta…
[ReplySink]    —— 攒输出 → 通过 API 发回聊天
```

| 模块 | 单一职责 | 接口 |
|---|---|---|
| **EventSource** | 翻译原始事件为规范化事件；断线自动重连并续传 | 产出 `NormalizedEvent` |
| **Router** | 判定触发；按 `chatId` 复用或新建会话；并发/排队控制 | `handle(event)` |
| **OmpClient** | 包装单个 omp RPC 进程：等 `ready`、发 `prompt`、收事件流、`abort`、优雅退出 | 一进程 ↔ 一 `chatId` |
| **ReplySink** | 把 omp 输出变成一条或多条 Anytype 消息；带幂等键 | `send(chatId, text)` |

### 触发判定（Router，规则写死）

1. 聊天内：消息带 **bot 的 participant id** 的 mention mark → 触发
2. 私聊（bot 与用户的 1:1 chat）：**每条都触发**
3. bot 自己发的消息 → **永不触发**（防自循环）
4. 触发时**剥掉 @bot 那段文本**再喂给 omp

### 会话生命周期

```
收到 chatId C 的事件
  ├─ C 有 omp 进程且空闲 → 直接 prompt
  ├─ C 有 omp 进程且忙   → 排队（按序）
  └─ 无进程 → 新建 omp --mode rpc（配 --session <每聊天持久会话文件>）
```

- 空闲回收：闲置 N 分钟（默认 15）→ 关 stdin 优雅退出
- 并发上限：常驻进程总数 ≤ 3，超出排队
- 持久化：每 chat 固定 `--session <path>`，bridge 重启后上下文仍在

## 5. 数据流（一次 @ 的完整路径）

1. 用户在 Anytype 里 @ai 提问
2. anytype-cli 的 SSE 流推给 bridge：「空间 S、聊天 C，成员 M 发了一条 @bot 的消息，内容 X」
3. bridge 找到/拉起 聊天 C 对应的 omp 进程，发 `{"command":"prompt","message":X}`
4. omp 跑 agent（可能调工具），逐字流式产出（`message_update` → `text_delta`）
5. bridge 攒到 `agent_end`，用 API `POST /v2/spaces/{space}/chats/{chat}/messages` 把回复发回聊天 C

## 6. 会话模型

**会话键 = `chat_id`。** 依据（v2 规范原文）：

> "A discussion is the comment thread under an object, and **it is a chat**: the returned id is the `chat_id` for every chat operation"

因此：页面 X 的讨论 = `chat_id_X`；主聊天 = `chat_id_main`；彼此独立，**自动按"文件 vs 主聊天"分开**，无需对象匹配逻辑。

可选优化：拉起会话时用 `GET /v2/spaces/{space}/objects/{object_id}` 取页面标题，给 omp 会话 `--name`，便于在会话列表中辨认。

## 7. 全局记忆

用 **omp 内置的 mnemopi 后端**，不自行实现。

- `memory.backend = mnemopi`
- `mnemopi.scoping = global` —— **一个记忆库，所有会话可见**（跨 chat 共享）
- `mnemopi.llmMode = smol` —— 记忆的提取/整理由模型自己完成（对话文本会到达 provider）
- `autoRecall` / `autoRetain` 保持默认开启

持久化：记忆存容器内 `~/.omp/agent/memories/mnemopi/`。**挂专用 Docker volume** 覆盖 `~/.omp/agent/`（含 sessions、memories、config），使容器重建不丢。仍是容器自有卷，不挂主机路径，符合 R3。

> 概念区分：**全局记忆** = bot 跨会话记住"你说过的事"（本节，mnemopi）；**知识库检索** = bot 能查 Anytype 里的笔记（由 agent 容器的 `anytype-mcp` 提供，另一机制）。两者都要。

## 8. 错误处理

| 故障 | 行为 |
|---|---|
| SSE / anytype-cli 断连 | EventSource 退避重连；用 `Last-Event-ID` 续传（规范支持，只补新增），不丢消息 |
| omp 进程崩溃 | OmpClient 检测退出 → 标记该 chat 会话失效 → 下条消息重新拉起；持久会话则上下文还在 |
| LLM provider 报错（限流/鉴权/超时） | 交给 omp `set_auto_retry`；最终仍失败 → **回一条错误提示到聊天**，不静默 |
| agent 工具失败（如 anytype-mcp 调用错） | agent 在回复里自述，bridge 不特判 |
| 回复过长 | 按长度切成多条消息 |
| 自循环（bot @ 自己） | 规则层写死永不触发（§4） |
| 重复回帖（bridge 重启） | 发消息带 `Idempotency-Key` |
| 并发超限 | 排队（上限 3） |
| 密钥泄漏 | token/key 全走环境变量；日志脱敏；绝不打印 |

## 9. 测试

**1. 单元测试**（不依赖真 Anytype 网络）
- `Router`：各种消息（@bot / 私聊 / bot 自己 / 无 @）→ 断言是否触发
- `OmpClient`：用**假 omp 子进程**（按行吐 JSON）验证 spawn → `ready` → `prompt` → 收流 → `agent_end` → 关闭
- `ReplySink`：长文本分块逻辑

**2. 集成测试**（mock anytype-cli 的 HTTP/SSE）
- 模拟 @bot 事件流 → 断言 bridge 正确派发并调用发消息端点

**3. 手动 E2E 清单**
- 空间里 @bot → 是否回复
- 页面讨论里 @bot → 验证与主聊天是**不同会话**
- A 聊天说"记住X" → B 聊天问 → 验证**全局记忆生效**
- 断开 anytype-cli 再恢复 → 验证不丢、不重复回

取舍：单元 + 集成覆盖逻辑；E2E 覆盖真实连通性，手动执行（不做全自动）。

## 10. 风险与待验证

| # | 风险 | 缓解 |
|---|---|---|
| V1 | HTTP v2 只有 **per-chat SSE**，无账号级总流；`list_chats` 是否列出"页面讨论"未知（`ChatRow` 仅 id+name） | 首版：枚举空间 chats 逐个订阅；**实测**若漏讨论，改用 anytype-cli 的 gRPC 账号级事件流 `ListenSessionEvents` |
| V2 | 多个 omp 进程共享同一 mnemopi SQLite 库，官方**未说明**并发安全 | 并发上限 3；**实测**争用；退路是记忆服务化（复杂，尽量避免） |
| V3 | 完整 agent = 能跑命令，安全敏感 | 严格隔离容器（R3）+ 并发/资源限制 |
| V4 | omp 未安装；`omp.sh/install` 可信度需确认 | 安装前核对来源与校验；备选 npm 包 `@oh-my-pi/pi-ai` |

## 11. 交付物

- `anytype-cli` 服务启用（compose 中取消注释 + 建 bot 账号）
- `bridge`（Node 项目：四模块 + 容器化）
- agent 容器 Dockerfile（debian-slim + omp + anytype-mcp）
- `.env` / compose 片段、持久卷定义
- 部署与运维说明
