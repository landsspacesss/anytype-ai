# 聊天输出：旁白流式 + 按行换气泡 设计

日期：2026-10-03
状态：待实现

## 1. 背景（已实测确认）

- 模型在**调工具前**常写一段正文（旁白，如"我打算用 anytype_search 搜一下…"）。实测：pi 以 `text_delta` **流出**这段文本，而当前 `pi-session` 的 `collected` **把所有文本段拼在一起**——所以现在 bot 的回复 = `旁白 + 最终答案` 粘成一段。例：
  `"我打算用 anytype_search 搜索关键词"考试"…然后汇总结果。搜索"考试"共命中 6 条结果…"`
- 聊天正文**不按行拆**：多行回复挤成一大段。

## 2. 目标

1. **旁白流式**：模型每段"调工具前正文"**实时显示**；但**只是运行时的活进度**——回合结束**清掉**，聊天里最终**只保留答案**。
2. **按行换气泡**：**最终答案**按 `\n` 拆成**多条消息**（空行跳过）。

## 3. 机制

### 3.1 分段（pi-session）

在订阅处理里维护 `segmentBuf`（累积 `text_delta`）：

- **`tool_execution_start`**：若 `segmentBuf` 非空 → 把它作为**旁白**上报（`onProgress({kind:"narration", text})`）并清空 `segmentBuf`。（这段就是"调工具前那句话"。）
- **prompt 结束**：`collected` = 剩下的 `segmentBuf`（= **最终答案**，不再包含任何旁白）。
- `thinking_start` / `tool_*` 照旧上报。

> 语义：**答案 = 最后一段文本**（最后一个工具调用之后的正文）。若回合结束前没有新文本（最后一个动作是工具/思考）→ 答案为空（不额外发东西）。

### 3.2 轮转气泡（`StatusReporter`，`src/reply/status.ts`）

一条"当前气泡"承载当前阶段，事件到达时**原地改**，必要时**另开**：

| 事件 | 行为 |
|---|---|
| `thinking` | 当前气泡 = `🧠 思考中…`（没有则按 `delayMs` 建）|
| `narration(text)` | 当前气泡**原地改成该正文**；标记"当前是文本" |
| `tool(tool,args)` | 若"当前是文本" → **另开一条**新气泡 = `⏳ 正在 …`；否则**原地**改成 `⏳` |

- 于是"要调工具但前面没正文"时**不新开**（原地 `🧠→⏳`），符合"没正文就别开新气泡"。

### 3.3 回合结束（`finish(reply)`）

- **删掉所有中间气泡**（状态条 + 旁白条）。
- **发最终答案**：`reply` 按 `\n` 拆行（空行跳过），**每行一条消息**（仍受 `replyMaxLen` 截断）。
- 若 `reply` 为空 → 不发。
- （`stop()` 用于错误/中断：删掉所有气泡、不发答案；错误消息由 Router 发。）

### 3.4 Router / 接口

- `AgentProgress` 增 `{ kind: "narration"; text: string }`。
- `ProgressCallback` 不变（旁白走同一路）。
- `Router`：成功时 `await reporter?.finish(reply)`（有 reporter 则它负责发答案与清中间条）；**无 reporter**（`TOOL_STATUS=false`）时，Router 自己把 `reply` 按行发。
- 抽一个共享 `sendLines(send, target, text, maxLen)`：按行拆、逐条发（供 reporter 与 Router 共用）。

## 4. 边界

- **快回合**（没触发占位条就答完）：无气泡可复用 → 直接把答案按行发。
- **旁白条也按行吗？** 旁白是**瞬态**（回合结束即删），保持**单条气泡**原样显示（不拆）；按行拆分只作用在**最终答案**（会留存的消息）。—— *此点按直觉处理，若你希望旁白在运行中也按行拆，一句话即可改。*
- **内容安全**：仍是纯文本（不引入 Markdown）；每行独立发送。
- 撤回中间条时若某条 posting 还在飞（延迟占位），按现有 `StatusReporter` 的"飞行中撤回"逻辑处理。

## 5. 组件与改动

| 文件 | 改动 |
|---|---|
| `src/session/manager.ts` | `AgentProgress` 增 `narration` |
| `src/agent/pi-session.ts` | 分段：`tool_execution_start` flush 旁白；`collected` = 末段 |
| `src/reply/status.ts` | `StatusReporter` 增轮转气泡 + `finish(reply)`；抽 `sendLines` |
| `src/router/router.ts` | 成功时 `reporter.finish(reply)`；无 reporter 时按行发 |

## 6. 测试

- **单元**（`pi-session`）：分段——喂入 `text_delta "*旁白*" → tool_execution_start → text_delta "*答案*"`，断言 `onProgress` 收到 `narration("旁白")`，且 `prompt()` 返回 `"答案"`（不含旁白）。
- **单元**（`status`）：轮转——thinking→narration 原地改；narration→tool **另开**；thinking→tool **原地**（不另开）；`finish` 删中间条并按行发（空行跳过）。
- **单元**（`router`）：有 reporter 走 `finish`；无 reporter 按行发；错误路径只发 error。
- **实机**（dev-test）：让它做多步任务 → 看到 `🧠→旁白`（原地）、`⏳ 工具`（另开）、…、回合末**只剩答案且按行成多条**；确认中间旁白条被清掉。

## 7. 非目标（YAGNI）

- 不做 Markdown 渲染（聊天仍是纯文本）。
- 不改状态条的节流/合并逻辑。
- 不把旁白持久化（它是瞬态进度）。
