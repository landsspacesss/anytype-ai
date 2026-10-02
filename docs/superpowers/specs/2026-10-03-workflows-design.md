# 工作流（Workflow）设计 —— 引擎编排（GH-Actions 风格）

日期：2026-10-03
状态：待实现
取代：`2026-10-02-workflows-design.md`（agent 编排版，作废）

## 1. 背景与目标

工作流 = **引擎编排的一串有序步骤**（像 GitHub Actions），**确定性执行**；**只有在必要的那一步才调用 agent**（agent 是步骤类型之一，不是全程 agent）。引擎负责：按序跑、**记录每步状态/日志**、失败可重试、**中断可从断点续跑**。

与「技能」分开存放（用户要求）：技能是"给 agent 的知识"，工作流是"给引擎的脚本"。

## 2. 定义：`docker/workflows/<name>/workflow.yaml`（+ 可选 `README.md`）

```yaml
name: daily-exam-summary
description: 每天9点总结试卷变化并提醒（列表/通知用）
on:
  cron: "0 9 * * *"          # 可选；缺省=仅手动
  notify: "<chatId>"          # cron 跑时结果发到哪；手动跑=当前聊天
steps:
  - id: read
    uses: anytype
    with: { op: read_object, id: "<objid>" }
  - id: judge                 # ← 仅这一步调 agent
    uses: agent
    with: { space: pqdthe, prompt: "判断这份卷子较昨天有无变化，只回 yes/no" }
  - id: summarize
    if: "{{ steps.judge.output }} == 'yes'"
    uses: agent
    with: { space: pqdthe, prompt: "把变化总结成3条要点" }
  - id: notify
    if: "{{ steps.summarize.output }}"
    uses: anytype
    with: { op: send_message, chat: "{{ on.notify }}", text: "{{ steps.summarize.output }}" }
```

启动时 `ensureWorkflowsConfig` 把 `docker/workflows/<name>/workflow.yaml`（+ README）拷进 pi agentDir 的 **`workflows/`**（与 `skills/` 分开；**只补缺不覆盖**，改已部署的先删卷内副本再重建）。

## 3. 步骤类型（4 种）

| `uses` | `with` | 输出（存 `steps.<id>.output`）|
|---|---|---|
| `shell` | `run`（命令串）、可选 `cwd` | stdout（截断到 N 字符）|
| `anytype` | `op`（`read_object`/`create_note`/`insert_markdown`/`set_property`/`send_message`/`search`/`list_objects` …）+ 该 op 的参数 | 结果文本/JSON |
| `http` | `url`、`method`（默认 GET）、可选 `headers`/`body` | 响应体（截断）|
| `agent` | `space`（id 或名字）、`prompt`、可选 `tools`（默认全工具） | 子会话返回的**文本** |

- **有序执行**（顺序数组）；每步可 `if: <条件>`（**简单字符串比较/真值**，非表达式引擎）；可 `retry: N`（失败重试次数）。
- 变量插值：`{{ steps.<id>.output }}`、`{{ on.cron }}`/`{{ on.notify }}`（触发上下文）、`{{ env.X }}`（容器 env，白名单）。**只做字面替换**，不求值。
- **agent 步骤**复用现有 `createChildAgent({spaceId,cwd,readOnly:false})`（绑目标 space 的子会话 + 其工作区），跑完取文本。

## 4. 运行（Run）：状态 / 日志 / 续跑

- 每个 run 一个目录 **`/workspace/workflow-runs/<id>/`**：
  - `state.json`：`{ id, name, trigger, chatId, status, steps: [{id, uses, status, output?, error?, startedAt, endedAt}] }`；`status ∈ running|done|failed|awaiting_approval`；步 `status ∈ pending|running|done|failed|skipped`。
  - `log.ndjson`：逐步日志。
  - `steps/<id>.out`：该步产出（大输出落文件，state 里只存引用/截断）。
- **失败语义**：某步失败（重试用尽）→ **中止**，run 标 `failed`，状态保留。
- **续跑**：`/run <name> --resume <runId>` → 从**第一个非 done 步骤**继续（已完成步骤不重跑，用其存的 output）。

## 5. 触发（v1）

- **手动**：`/run <name> [k=v …]`（`/runs` 列历史；聊天里点名亦可）。
- **cron**：复用现有 watch 调度器（`pollDueWatches` tick）；命中即起 run，结果发到 `on.notify`。

## 6. 输出与「工作流状态对话」

- run 结果帖子落在**触发它的聊天**（手动=当前聊天；cron=`on.notify`）。
- **专门的 workflow 状态对话**聚合每步生命周期事件：
  ```
  ▶ r7f2 daily-exam-summary · 触发 cron 09:00
    ✅ read
    ✅ judge → yes
    ▶ summarize …
    ❌ notify: 失败 …
  ```
  指定：env `WORKFLOW_STATUS_CHAT`（chat id）；未设则首次需要时**自动建一个固定聊天**（`createChat`）。事件由**引擎**在步骤状态变化时投递（不靠 agent）。

## 7. 安全

- `anytype` **写**步骤（create/insert/set_property/send_message）与 `agent` 步骤的写入，走**现成批准闸门**（按该 run 所在聊天的 auto/ask 模式）。控制台自身只读：跑写型工作流需先 `/yolo auto` 解锁（由 worker 在目标空间执行），或直接在普通空间跑。
- `shell`/`http` 步骤**不额外加闸门**（与普通会话里 agent 用 bash 同等对待）——v1 记此限制。

## 8. 组件与改动

| 单元 | 责任 |
|---|---|
| `src/workflow/schema.ts`（新） | 解析/校验 `workflow.yaml`（name/description/on/steps；`Step` 类型；变量插值 `render()`）|
| `src/workflow/store.ts`（新） | run 目录读写：`state.json` / `log.ndjson` / `steps/*.out`（`WorkflowRunStore`）|
| `src/workflow/runner.ts`（新） | `runWorkflow(def, opts)`：按序执行、`if`、`retry`、写状态/日志、投状态事件、（`resume`）从断点续 |
| `src/workflow/steps.ts`（新） | 4 个步骤执行器（`shell`/`anytype`/`http`/`agent`）；`agent` 用注入的 `runAgent(space,prompt,tools)` |
| `src/agent/pi-session.ts`（改） | `ensureWorkflowsConfig`（拷贝）；`runAgentInSpace`（复用 `createChildAgent`）|
| `src/commands/handler.ts`（改） | `/run`、`/runs`（`/run --resume <id>`）|
| `src/main.ts`（改） | 接线 `/run`；状态对话发现/创建；**cron 触发**挂进 `pollDueWatches` |
| `src/config.ts` / `types.ts`（改） | `workflowStatusChat?`（env `WORKFLOW_STATUS_CHAT`）、`workflowDir`（默认 `/app/workflows`）、`runDir`（`/workspace/workflow-runs`）|

## 9. 测试

- **单元**：`schema` 解析（合法/非法、`if`/`retry`/变量）；`render()` 插值；`runner`（顺序、`if` 跳过、`retry`、失败中止、`resume` 跳过已完成步）；`steps` 各执行器（注入 fake api/fetch/agent）。
- **实机**（dev-test）：`/run <工作流>` 起一个含 `anytype`+`agent`+`anytype` 的流程 → 每步状态/日志正确、状态对话出现事件；改一步失败 → run failed、`--resume` 续跑；cron 到点起 run。

## 10. 非目标（YAGNI）

- 不做 DAG/并行（**有序列表**）。
- 不做表达式引擎（`if` 只是简单比较/真值）。
- 不做 run 并发上限/队列（先直接跑）。
- 不做消息/对象变化触发（v1 只 手动 + cron）。
- 不给 `shell`/`http` 单独加闸门（记为限制）。
