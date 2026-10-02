# 批准流（Approval Flow）设计

日期：2026-10-02
状态：待实现

## 1. 背景与目标

当前 `/yolo` 是**能力开关**：`on`=全工具、`off`=只读（工具集里直接去掉写工具）。它不是真正的"批准"——它不让模型"问一下再写"，而是干脆**不能写**。

pi 暴露了扩展钩子 `pi.on("tool_call", handler)`（handler 被 **await**，返回 `{block:true, reason}` 可拦截一次工具执行）。据此做一个**真正的批准流**：写操作执行前在 Anytype 聊天里问用户，用户回 `/approve` / `/deny`，未获批准则 block。

### 设计原则

- **不删工具**：模式只改变"是否闸门 / 子会话是否只读"，不改工具注册面（避免"工具消失"造成的困惑）。
- **无人值守安全**：等待超时默认**拒绝**。
- **控制台不受影响**：控制台仍恒只读、且不带 subagent（上一轮评审的安全边界）。

## 2. 模式（三态，per-chat）

`ApprovalMode = "auto" | "ask" | "readonly"`。默认 **`auto`**（普通空间，行为同现状）；**控制台恒 `readonly`**（`/yolo` 在控制台无效）。

| 模式 | 主会话工具集 | 闸门（`tool_call`） | 子会话 |
|---|---|---|---|
| `auto`（默认） | 全部 | 无 | 全部（可写） |
| `ask` | 全部 | 拦"非安全"工具→问用户；`subagent`/`agent`→**直接拒绝并提示**（不询问） | 不会创建（subagent 被拦） |
| `readonly` | 安全集 **+ `subagent`/`agent`** | 无（无写工具可拦） | **安全集**（不可写） |

- **`readonly` 仍能派子代理**，但子会话继承"只读"→ 子代理也写不了（绕不过）。
- **子会话恒不带 `subagent`/`agent`**（防递归）——不变。

## 3. 工具分类：安全集 `SAFE_TOOLS`

闸门只拦"非安全"工具；`readonly` 模式 = 安全集（+ 子代理）。

`SAFE_TOOLS`（无需批准、readonly 可用）：
```
read, ls, grep, find,                          // pi 内置：纯本地读
anytype_list_objects, anytype_search, anytype_read_object,
anytype_list_properties, anytype_list_types, anytype_templates,
anytype_download_images, anytype_download_file, crop_image,
web_search, web_fetch
```
（即现有的 `READONLY_TOOLS` **并上** pi 的纯读工具 `read/ls/grep/find`——否则每次读文件都要批准，太吵。）

**其余一律算"非安全"**（`ask` 下需批准）：所有 anytype 写工具、`bash`、`write`、`edit`、`subagent`、`agent`、以及任何未知/新工具（**默认从严**：不在 `SAFE_TOOLS` 里就要批准）。

> 注：`read/ls/grep/find` 可读容器内本地文件（含挂载的 CLI 配置）。这与现状（`CONSOLE_TOOLS` 已含它们）一致，属已接受的既有取舍。

**控制台**不改：仍用 `CONSOLE_TOOLS`（= `SAFE_TOOLS` + `anytype_list_spaces`/`anytype_memories`/`anytype_join_space`，**不含** subagent）。

## 4. 闸门行为

- 挂钩子：`new DefaultResourceLoader({ cwd, agentDir, extensionFactories: [approvalFactory] })` → 传给 `createAgentSession`。工厂 `(pi) => pi.on("tool_call", handler)`。
- `handler(event)` 逻辑（仅 `ask` 模式生效）：
  1. 工具 ∈ `SAFE_TOOLS` → 放行（`undefined`）。
  2. 工具 ∈ {`subagent`,`agent`} → `{block:true, reason:"ask 模式不支持子代理（会绕过批准）；请用 /yolo auto，或直接在会话里做。"}`（**提示，不询问**）。
  3. 否则（需批准）：
     - 若 `approvedAllThisTurn` → 放行。
     - 否则向聊天发提问消息，`await` 用户决定（见下），返回 `{block: !approved, reason}`。
- **粒度**：**每次写调用都问**；用户回 `/approve all` 后置 `approvedAllThisTurn=true`，**本回合剩余写全部放行**。
- **回合重置**：进入 `prompt()` 时 `approvedAllThisTurn=false`。

### 提问与决定

- 提问消息（`api.sendMessage`，复用当前聊天）：`⚠️ 想执行 <tool>(<关键参数>)，回复 /approve、/approve all 或 /deny`
  - 参数摘要复用 `src/reply/status.ts` 的 `formatToolProgress` 风格（截断、去换行）。
- 用户回复（**桥指令**，不经 agent，所以回合卡住时也能处理）：
  - `/approve` → 放行当前这一次
  - `/approve all` → 放行本回合剩余全部
  - `/deny` → 拒绝当前这一次
- **超时**：`APPROVAL_TIMEOUT_MS`（默认 **300000**=5 分钟）→ 默认**拒绝**（`block:true`, reason="等待批准超时，已按拒绝处理"）。
- 状态占位消息期间显示 `⏳ 等待批准…`（复用状态上报链路）。

## 5. 与打断（barge-in）的交互

- 闸门 `await` 期间监听回合的 `AbortSignal`（`ctx.signal`）：**被 abort → 按拒绝收尾**（不悬挂、不泄漏定时器）。
- **普通新消息**到达 → 打断当前回合（既有语义）→ 闸门随即按拒绝结束。
- **`/approve`/`/deny`** 是命令、不打断回合 → 只解开待批准。
- 回合结束/被打断 → 清 `approvedAllThisTurn` + 清待批准。

## 6. 组件与接口

| 单元 | 责任 | 接口（供相邻任务） |
|---|---|---|
| `src/agent/approval.ts`（新） | `ApprovalGate`：单聊天的待批准状态机（request/resolve/cancel/resetTurn）。**纯逻辑**，注入 `post`、`timeoutMs`、`now`/timer → 可单测 | `class ApprovalGate { constructor(opts); needsApproval(tool): boolean; async request(tool, args, signal): Promise<boolean>; resolve(kind:"approve"\|"all"\|"deny"): boolean; resetTurn(): void; get approvedAll(): boolean }` |
| `src/agent/pi-session.ts` | 建带 `extensionFactories` 的 `DefaultResourceLoader`；`effectiveToolNames` 改三态；`ask` 用扩展闸门（非删工具）；暴露 `setApprovalMode/getApprovalMode/approvePending` | `setApprovalMode(m: ApprovalMode): ApprovalMode`、`getApprovalMode(): ApprovalMode`、`approvePending(kind): boolean` |
| `src/session/manager.ts` | `ManagedClient` 加三方法；**per-chat 持久化模式**（同打断策略 `policies` 的写法，重建后保留） | `setApprovalMode?(m)`/`getApprovalMode?()`/`approvePending?(kind)`；`SessionManager.getApprovalMode(chatId)`/`setApprovalMode(chatId,m)`/`approvePending(chatId,kind)` |
| `src/commands/handler.ts` | `/yolo auto\|ask\|readonly`（+ `on`→auto、`off`→ask 别名）；新增 `/approve [all]`、`/deny`；`CommandContext` 扩展 | `CommandContext.setApprovalMode`/`getApprovalMode`/`approvePending` |
| `src/main.ts` | 接线：命令 ctx ↔ SessionManager；闸门 post → `api.sendMessage`；`createPiClient` 传 `approvalGate` 与初始模式 | — |
| `src/config.ts` / `src/types.ts` | `approvalTimeoutMs`（env `APPROVAL_TIMEOUT_MS`，默认 300000） | — |

**子会话只读**：`createChildAgent` 按当前模式构造 —— `readonly` 时子会话 `applyTools` 用 `SAFE_TOOLS`。

## 7. 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `APPROVAL_TIMEOUT_MS` | `300000` | 待批准超时（超时=拒） |
| `APPROVAL_MODE` | `auto` | 普通空间**新会话**的默认模式（`auto`/`ask`/`readonly`）。控制台恒 `readonly` |

## 8. 测试

- **单元**（`test/approval.test.ts`）：`ApprovalGate` —— approve→true、deny→false、`all`→本回合后续直接 true、超时→false、abort→false、resetTurn 清 all。
- **单元**（`test/pi-session.test.ts`）：`effectiveToolNames` 三态 —— `auto`=全部；`ask`=全部（闸门另管）；`readonly`=安全集+子代理；控制台仍= `CONSOLE_TOOLS`（无 subagent）。
- **单元**（`test/commands-handler.test.ts`）：`/yolo auto|ask|readonly`、`on`/`off` 别名；`/approve`、`/approve all`、`/deny` 委托到 `approvePending`。
- **单元**（`test/approval-tools.test.ts` 或并入）：`needsApproval` 的分类（`bash`/`write`/`anytype_create_note`→需批准；`read`/`anytype_read_object`/`web_search`→免；**未知工具→需批准**）。
- **实机**：默认 `auto` 行为不变；`/yolo ask` 后写操作会发提问、`/approve` 放行、`/deny` 拒绝、`/approve all` 放行本回合；`ask` 下 `subagent` 被拒并提示；控制台仍恒只读；中断时闸门按拒收尾。

## 9. 兼容与迁移

- `/yolo off` 语义从"只读"变为"ask（每次问）"——**行为变化**，文档 + `/help` 要写清；想要只读用 `/yolo readonly`。
- 旧行为（只读）仍有等价出口：`/yolo readonly`。
- `READONLY_TOOLS` → 重命名/并入 `SAFE_TOOLS`（并上 `read/ls/grep/find`）；`effectiveToolNames` 与闸门共用它。

## 10. 非目标（YAGNI）

- 不做"按工具永久记住批准"（记忆式 allowlist）。
- 不做多用户/权限模型（只有"当前聊天的人"能批准）。
- 不改控制台的只读语义与其工具集。
- 不给 subagent 做独立闸门（`ask` 下直接不支持；`readonly` 下子会话只读）。
