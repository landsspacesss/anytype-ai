# 控制台派 worker（跨空间委派）设计

日期：2026-10-02
状态：待实现

## 1. 背景与目标

控制台是全局助手，但**恒只读**（`CONSOLE_TOOLS`，且不含子代理）——它能跨空间**读**，不能**写**。用户想让它当**总控**：把"去某个空间新建/整理一篇笔记"这类活**派给 worker**，worker 在**目标空间的上下文/工作区**里跑，能读写那个空间。

三个诉求合起来：
1. **写入任务委派** —— 控制台下指令，worker 落到目标空间去写。
2. **用目标空间的上下文/记忆** —— worker 在有**该空间** AGENTS.md / MEMORY.md 的工作区里跑，而不是控制台的全局工作区。
3. **并行 / 隔离** —— 多次派发各自独立，控制台对话不被中间过程塞满。

### 关键约束（安全）

控制台"恒只读"是**刻意的隔离**（防止在有别人的空间里泄露/污染）。本功能会开一条**写入路径**，所以必须显式授权：

- **控制台默认锁定**：只读、不能派 worker。
- **`/yolo auto`（控制台）解锁**：控制台可派 worker；worker 写入**不过批准闸门**（= 已显式授权）。
- **`/yolo readonly`（或 `ask`）锁回**。
- **控制台自身工具集永远只读**（它不直接写；写只发生在 worker 里）。
- → 即**恢复控制台的 `/yolo`**（推翻上一轮"控制台恒只读、`/yolo` 无效"的决定，改为"`/yolo` 只控制**能否派 worker**；控制台自己始终只读"）。

## 2. 角色与语义

| | 控制台 | worker |
|---|---|---|
| 对话 | **固定滚动对话**（现状；仅显式 `/new` 清） | **一次性**子会话，每次派发全新（等价自动 `/new`） |
| 工具集 | 永远只读（`CONSOLE_TOOLS`） | 目标空间的**完整**工具集（可写），但**不含** `subagent`/`agent`（不递归） |
| 工作区 | `/workspace/_global` | `/workspace/<目标space>`（该空间的 AGENTS.md / MEMORY.md） |
| 绑定空间 | 控制台空间（只读） | **目标空间（读写）** |
| 持久化 | 无（滚动对话除外） | 落在**目标空间**工作区 / MEMORY.md |

## 3. 新工具（仅控制台、仅解锁时注册）

`anytype_run_in_space(space, task)`
- `space`：目标空间 **id 或名字**（用既有 `resolveSpaceId` 解析）。
- `task`：自包含的任务描述（worker 看不到控制台对话）。
- 行为：起一个**一次性 worker**，绑到目标空间的 **spaceId + 工作区**，跑 `task`，返回最终文本。
- **可并发**：控制台可在一个回合里多次调用（`Promise.all` 风格）以并行/隔离。
- 只读/锁定时：**不注册**此工具（模型没有它就派不了）。

## 4. 组件与接口

| 单元 | 责任 |
|---|---|
| `src/agent/pi-session.ts`（改） | `createChildAgent` **参数化**：接受 `{ spaceId, cwd }`；`SubagentRegistry.create(name)` 改为 `create(opts)`；顶层会话把当前 `approvalMode`/`isConsole` 传给子会话构造，使 **readonly 子会话只读**（既有行为保持）。新增 `consoleUnlocked` 判定 |
| `src/agent/pi-session.ts` | 控制台会话：`applyTools` 用 `consoleTools(unlocked)` = `CONSOLE_TOOLS`（+ 解锁时 `anytype_run_in_space`）；新增 `setConsoleUnlocked(on)`/`isConsoleUnlocked()`（或复用 `setApprovalMode`：控制台 `auto`=解锁） |
| `src/agent/anytype-tools.ts`（改） | 新增 `anytype_run_in_space` 工具，deps 加 `runInSpace?: (space: string, task: string) => Promise<string>`，**仅**当 deps 带 `console` 且未锁定时注册 |
| `src/session/manager.ts` | 控制台模式沿用现有 per-chat `approvalModes`；无需新状态（`auto`=解锁） |
| `src/commands/handler.ts`（改） | `/yolo` 三态对控制台**重新生效**：`auto`=解锁（可派 worker）、`readonly`/`ask`=锁定；无参时控制台报告「锁定/解锁」。`CommandContext` 已有 `isConsole`/`setApprovalMode`/`getApprovalMode` |
| `src/main.ts`（改） | 控制台 `createClient` 里，把 `runInSpace` 注入 `console` dep（实现：起 worker 会话，cwd=`/workspace/<目标space>`、spaceId=目标、工具=全量（无 subagent）；`ensureAgentFiles` 播种该空间工作区） |

**复用点**：`createAnytypeTools` 已支持 `spaceId` + `workspaceDir` 参数——worker 只需传目标值。所以 worker 构造 = 现有 `createChildAgent` + 参数化 space/cwd。

## 5. 数据流

```
控制台消息 → agent 调 anytype_run_in_space("考试", "把XX整理成一篇笔记")
  → main 的实现：ensureAgentFiles(/workspace/考试)；createPiClient? 不——起一次性子会话
      （spaceId=考试, cwd=/workspace/考试, 工具=全量无 subagent, 无闸门）
  → 子会话跑 task（在该空间读写）→ 返回文本
  → 控制台把结果发给用户
```

## 6. 边界与安全

- worker **只能写目标空间**（那一个）；不跨空间。
- **控制台自己不写**（工具永远只读）。
- **默认锁定** → 不开 `/yolo auto` 就没有任何写入路径。
- worker **不含** `subagent`/`agent` → 不递归。
- `ask` 对控制台 = 锁定（不派 worker）；worker 写入始终**不过**闸门（一旦解锁=显式授权）。
- 控制台派 worker **只读**任务也允许（解锁状态下）。

## 7. 测试

- **单元**（`test/pi-session.test.ts`）：`consoleTools(unlocked)` —— 锁定=`CONSOLE_TOOLS`（无 `anytype_run_in_space`）；解锁=+该工具，且**仍无**任何 anytype 写工具。
- **单元**（`test/console-tools.test.ts`）：`anytype_run_in_space` 仅在「console dep + 未锁定」时注册；`space` 解析（id/名字）；锁定/非控制台→不注册。
- **单元**（`test/commands-handler.test.ts`）：控制台 `/yolo auto` 解锁、`/yolo readonly` 锁定、无参报告。
- **实机**（dev-test）：`/yolo auto` 后，让控制台「去 dev-test 新建一篇 XX」→ 确认**落在 dev-test**、控制台对话不被中间过程污染；再 `/yolo readonly` 确认派不动。

## 8. 非目标（YAGNI）

- 不做 worker 的**持久命名**（就是一次性；要常驻另说）。
- 不做 worker→worker 递归。
- 不改控制台的跨空间**读**语义。
- 不给 worker 单独做批准闸门（解锁即授权）。
