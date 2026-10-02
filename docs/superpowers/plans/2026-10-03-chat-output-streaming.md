# 聊天输出：旁白流式 + 按行换气泡 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把模型的"工具调用前正文"作为**瞬态旁白**实时显示（轮转气泡：🧠↔旁白原地改，出正文后调工具才另开），回合末**删掉所有中间气泡**、**只留最终答案并按行拆成多条消息**。

**Architecture:** 三处改动串起来：① `pi-session` 把流出的文本**分段**——调工具时把累积的那段当旁白上报，回合结束剩下的那一段才是答案（修掉现在"旁白+答案粘一起"）；② `StatusReporter` 重写为**轮转气泡**（当前气泡承载当前阶段的文本，工具跟随旁白时另开），并新增 `finish(reply)`（删中间条 + 按行发答案）；③ `Router` 在成功时调 `reporter.finish(reply)`，无 reporter 时自己按行发。

**Tech Stack:** TypeScript (NodeNext, strict)、vitest（含 `vi.useFakeTimers`）、内嵌 pi SDK。

## Global Constraints

- `AgentProgress` 增 `{ kind: "narration"; text: string }`（保持既有 `thinking`/`tool` 不变）。
- **答案 = 最后一段文本**（最后一个工具之后的正文）；若回合以工具/思考结束则答案为空，**不发**。
- **旁白是瞬态**：运行中可见，回合结束**删掉**；聊天里最终**只有答案**。
- 中间气泡=**纯状态条 + 旁白条**，回合末全部删除；**只有最终答案**留存。
- **按行拆分只作用于最终答案**（旁白/状态条保持单条；旁白会瞬态更新）。
- 纯文本，不引入 Markdown。
- 提交信息英文，风格 `feat:/test:/docs:`。
- 实机验证用 `docker build` + 重建 bot。

## 文件结构

| 文件 | 责任 |
|---|---|
| `src/session/manager.ts`（改） | `AgentProgress` 增 `narration` |
| `src/agent/pi-session.ts`（改） | `TextSegmenter`（纯，导出）+ 订阅里分段；`collected` = 末段 |
| `src/reply/status.ts`（改） | `splitLines`/`sendLines`；`StatusReporter` 轮转气泡重写 + `finish(reply)` |
| `src/router/router.ts`（改） | 成功 `reporter.finish(reply)`；无 reporter 按行发 |
| `test/pi-session.test.ts` / `test/status.test.ts` / `test/router.test.ts` | 测试 |

---

### Task 1: 分段（TextSegmenter + pi-session）

**Files:**
- Modify: `src/session/manager.ts`、`src/agent/pi-session.ts`
- Test: `test/pi-session.test.ts`

**Interfaces:**
- Produces:
  - `AgentProgress` 增 `| { kind: "narration"; text: string }`
  - `export class TextSegmenter { push(delta: string): void; narration(): string | null; answer(): string }`

- [ ] **Step 1: 写失败测试**（追加到 `test/pi-session.test.ts`）

```ts
import { TextSegmenter } from "../src/agent/pi-session.js";

describe("TextSegmenter", () => {
  it("narration() returns the text accumulated since the last take, trimmed", () => {
    const s = new TextSegmenter();
    s.push("我先 ");
    s.push("查一下。");
    expect(s.narration()).toBe("我先 查一下。");
    expect(s.narration()).toBeNull(); // buffer cleared
  });

  it("answer() returns the remaining text (end of turn)", () => {
    const s = new TextSegmenter();
    s.push("旁白"); expect(s.narration()).toBe("旁白");
    s.push("这是答案");
    expect(s.answer()).toBe("这是答案");
  });

  it("blank narration is null (tool call with no preceding text)", () => {
    const s = new TextSegmenter();
    s.push("   \n ");
    expect(s.narration()).toBeNull();
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run test/pi-session.test.ts`
Expected: FAIL（`TextSegmenter` 未导出）

- [ ] **Step 3: 实现**

3a. `src/session/manager.ts` — `AgentProgress` 加一支：

```ts
export type AgentProgress =
  | { kind: "thinking" }
  | { kind: "tool"; tool: string; args?: unknown }
  /** The model's prose emitted just before a tool call (transient "narration"). */
  | { kind: "narration"; text: string };
```

3b. `src/agent/pi-session.ts` — 新增导出类（放在 `decideInterrupt` 之后）：

```ts
/**
 * Segments the assistant's streamed text: each contiguous run of text is either
 * a "narration" (emitted just before a tool call) or the final answer (the text
 * remaining at the end of the turn). The buffer is consumed on each read.
 */
export class TextSegmenter {
  private buf = "";
  push(delta: string): void {
    this.buf += delta;
  }
  private take(): string {
    const t = this.buf.trim();
    this.buf = "";
    return t;
  }
  /** Text since the last read, trimmed — null when blank (nothing said before the tool). */
  narration(): string | null {
    const t = this.take();
    return t.length > 0 ? t : null;
  }
  /** Text remaining at end of turn — this is the reply. */
  answer(): string {
    return this.take();
  }
}
```

3c. `pi-session.ts` 订阅处理里，把 `collected += delta` 改为分段。**先**在 `let collected = "";` 附近加 `let segmenter = new TextSegmenter();`（`collected` 保留为上報答案的变量名或直接用 segmenter）：

```ts
  const unsubscribe = session.subscribe((e) => {
    if (e.type === "message_update") {
      const ev = e.assistantMessageEvent;
      if (ev?.type === "text_delta") {
        segmenter.push(ev.delta);      // was: collected += ev.delta
      } else if (ev?.type === "thinking_start") {
        currentProgress?.({ kind: "thinking" });
      }
    } else if (e.type === "tool_execution_start") {
      if (typeof e.toolName === "string") {
        // Flush whatever prose preceded this tool call as a transient narration.
        const narr = segmenter.narration();
        if (narr) currentProgress?.({ kind: "narration", text: narr });
        currentTool = { name: e.toolName, interruptible: isInterruptibleTool(e.toolName) };
        currentProgress?.({ kind: "tool", tool: e.toolName, args: e.args });
      }
    } else if (e.type === "tool_execution_end") {
      currentTool = null;
      if (pendingInterrupt) { pendingInterrupt = false; void doAbort(); }
      currentProgress?.({ kind: "thinking" });
    }
  });
```

3d. `prompt()` 里：把 `collected = "";` 改为 `segmenter = new TextSegmenter();`，结束时返回 `turnAborted ? "" : segmenter.answer()`。删掉 `let collected = ""` 与对它的引用。

3e. 若 `collected` 在别处被引用（如子会话 `collected += ...`），子会话那段**保持不动**（那是 ChildAgent 自己的 collected，与分段无关）。

- [ ] **Step 4: 运行，确认通过 + 全量**

Run: `npx vitest run test/pi-session.test.ts && npx tsc --noEmit && npx vitest run`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/session/manager.ts src/agent/pi-session.ts test/pi-session.test.ts
git commit -m "feat(chat): segment narration from the final answer"
```

---

### Task 2: `StatusReporter` 轮转气泡 + `finish`

**Files:**
- Modify: `src/reply/status.ts`
- Test: `test/status.test.ts`

**Interfaces:**
- Produces:
  - `export function splitLines(text: string): string[]`（按 `\n` 拆、trim、去空行）
  - `export function sendLines(send: MessageSender, target: ChatTarget, text: string): Promise<void>`
  - `export type MessageSender = (target: ChatTarget, text: string) => Promise<void> | void`
  - `StatusReporterOptions.send?: MessageSender`（`finish` 发答案用）
  - `StatusReporter.finish(reply: string): Promise<void>`
  - `StatusReporter.stop(): Promise<void>`（无答案收尾——删中间条）

- [ ] **Step 1: 写失败测试**（追加到 `test/status.test.ts`）

```ts
import { describe, it, expect, vi } from "vitest";
import { StatusReporter, splitLines, sendLines } from "../src/reply/status.js";

function fakeTransport() {
  let n = 0;
  return {
    post: vi.fn(async () => `m${++n}`),
    edit: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  };
}

describe("splitLines / sendLines", () => {
  it("splits on newlines, trims, drops blanks", () => {
    expect(splitLines("a\n\n  b  \r\nc")).toEqual(["a", "b", "c"]);
  });
  it("sendLines sends one message per line", async () => {
    const send = vi.fn(async () => {});
    await sendLines(send, { spaceId: "s", chatId: "c" }, "one\ntwo");
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(1, expect.anything(), "one");
    expect(send).toHaveBeenNthCalledWith(2, expect.anything(), "two");
  });
});

describe("StatusReporter rotating bubbles", () => {
  const T = { spaceId: "s", chatId: "c" };

  it("narration replaces the thinking bubble in place (no new post)", async () => {
    vi.useFakeTimers();
    try {
      const status = fakeTransport(); const send = vi.fn(async () => {});
      const r = new StatusReporter({ status, send, delayMs: 0, editIntervalMs: 0 });
      r.start(T);
      r.onProgress({ kind: "thinking" });
      await vi.advanceTimersByTimeAsync(0);            // placeholder posts
      r.onProgress({ kind: "narration", text: "让我查一下" });
      await vi.advanceTimersByTimeAsync(0);            // edit to narration
      expect(status.post).toHaveBeenCalledTimes(1);
      expect(status.edit).toHaveBeenLastCalledWith(expect.anything(), "m1", "让我查一下");
    } finally { vi.useRealTimers(); }
  });

  it("a tool AFTER narration opens a NEW bubble", async () => {
    vi.useFakeTimers();
    try {
      const status = fakeTransport(); const send = vi.fn(async () => {});
      const r = new StatusReporter({ status, send, delayMs: 0, editIntervalMs: 0 });
      r.start(T);
      r.onProgress({ kind: "narration", text: "先查" });
      await vi.advanceTimersByTimeAsync(0);
      r.onProgress({ kind: "tool", tool: "anytype_search", args: {} });
      await vi.advanceTimersByTimeAsync(0);
      expect(status.post).toHaveBeenCalledTimes(2);   // second bubble
    } finally { vi.useRealTimers(); }
  });

  it("a tool WITHOUT preceding narration reuses the bubble (no new post)", async () => {
    vi.useFakeTimers();
    try {
      const status = fakeTransport(); const send = vi.fn(async () => {});
      const r = new StatusReporter({ status, send, delayMs: 0, editIntervalMs: 0 });
      r.start(T);
      r.onProgress({ kind: "tool", tool: "anytype_search", args: {} });
      await vi.advanceTimersByTimeAsync(0);
      expect(status.post).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it("finish removes every transient bubble then sends the answer per line", async () => {
    vi.useFakeTimers();
    try {
      const status = fakeTransport(); const send = vi.fn(async () => {});
      const r = new StatusReporter({ status, send, delayMs: 0, editIntervalMs: 0 });
      r.start(T);
      r.onProgress({ kind: "narration", text: "先查" });
      await vi.advanceTimersByTimeAsync(0);
      r.onProgress({ kind: "tool", tool: "anytype_search", args: {} });
      await vi.advanceTimersByTimeAsync(0);
      await r.finish("答案一\n答案二");
      expect(status.remove).toHaveBeenCalledTimes(2); // both bubbles
      expect(send).toHaveBeenNthCalledWith(1, expect.anything(), "答案一");
      expect(send).toHaveBeenNthCalledWith(2, expect.anything(), "答案二");
    } finally { vi.useRealTimers(); }
  });

  it("empty answer sends nothing (turn ended right after a tool)", async () => {
    vi.useFakeTimers();
    try {
      const status = fakeTransport(); const send = vi.fn(async () => {});
      const r = new StatusReporter({ status, send, delayMs: 0, editIntervalMs: 0 });
      r.start(T);
      r.onProgress({ kind: "tool", tool: "x", args: {} });
      await vi.advanceTimersByTimeAsync(0);
      await r.finish("");
      expect(send).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run test/status.test.ts`
Expected: FAIL（`splitLines`/`StatusReporter` 新行为未实现）

- [ ] **Step 3: 实现**（`src/reply/status.ts`）

3a. 在 `formatProgress` 之后加：

```ts
/** A message poster (the Router's sink). */
export type MessageSender = (target: ChatTarget, text: string) => Promise<void> | void;

/** Split a reply into chat messages: one per non-blank line. */
export function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Send `text` as one message per (non-blank) line. */
export async function sendLines(send: MessageSender, target: ChatTarget, text: string): Promise<void> {
  for (const line of splitLines(text)) await send(target, line);
}
```

3b. `StatusReporterOptions` 加：

```ts
  /** Poster for the final answer (used by `finish`). */
  send?: MessageSender;
```

3c. 用下面的实现**替换** `StatusReporter` 类（保留上面的 `formatProgress`/`formatToolProgress`/`STATUS_*`；删掉旧的单气泡逻辑，改为多气泡）：

```ts
interface Bubble {
  id?: string;
  text: string;
  posted: boolean;
}

/**
 * Drives the turn's live chat output as a sequence of "bubbles":
 *
 *  - One bubble carries the current phase; it starts as a 🧠/⏳ status line and,
 *    when the model emits prose (narration), is edited IN PLACE to that prose.
 *  - When a TOOL follows such prose, a NEW bubble is opened (so the prose stays
 *    visible); a tool that does NOT follow prose just overwrites the status line.
 *  - `finish(reply)` removes EVERY transient bubble, then sends the answer split
 *    into one message per line. `stop()` removes them with no answer.
 *
 * The first bubble is posted after `delayMs` (fast turns never flash a bubble).
 * All failures are swallowed (logged) so status never breaks the turn.
 */
export class StatusReporter {
  private target?: ChatTarget;
  private bubbles: Bubble[] = [];
  private active?: Bubble;
  private activeIsNarration = false;
  private started = false;
  private delayTimer?: ReturnType<typeof setTimeout>;
  private editTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private disabled = false;
  private posting?: Promise<void>;
  private editing?: Promise<void>;

  constructor(private readonly opts: StatusReporterOptions) {}

  private warn(msg: string): void {
    (this.opts.log ?? ((m: string) => console.warn(m)))(msg);
  }

  start(target: ChatTarget): void {
    if (this.disabled || this.stopped) return;
    this.target = target;
    const delay = this.opts.delayMs ?? 1500;
    this.delayTimer = setTimeout(() => {
      this.delayTimer = undefined;
      this.started = true;
      this.flushPost();
    }, delay);
  }

  /** Called as the turn's phase changes. */
  onProgress(p: AgentProgress): void {
    if (this.disabled || this.stopped || !this.target) return;
    if (p.kind === "narration") {
      this.setActiveText(p.text, true);
    } else if (p.kind === "tool") {
      if (this.activeIsNarration) this.active = undefined; // open a new bubble
      this.setActiveText(formatToolProgress(p.tool, p.args), false);
    } else {
      if (this.activeIsNarration) this.active = undefined;
      this.setActiveText(STATUS_THINKING, false);
    }
  }

  private setActiveText(text: string, narration: boolean): void {
    if (!this.active) {
      this.active = { text, posted: false };
      this.bubbles.push(this.active);
      if (this.started) this.flushPost();
    } else {
      this.active.text = text;
    }
    this.activeIsNarration = narration;
    if (this.active.posted) this.scheduleEdit();
  }

  private flushPost(): void {
    const b = this.active;
    if (!b || b.posted || this.disabled || this.stopped || !this.target) return;
    const isFirst = this.bubbles[0] === b;
    const text = isFirst ? STATUS_PLACEHOLDER : b.text;
    const p = this.doPost(b, text).finally(() => {
      if (this.posting === p) this.posting = undefined;
    });
    this.posting = p;
  }

  private async doPost(b: Bubble, text: string): Promise<void> {
    if (!this.target) return;
    try {
      const id = await this.opts.status.post(this.target, text);
      if (this.stopped) {
        await this.safeRemove(id);
        return;
      }
      b.id = id;
      b.posted = true;
      if (b.text !== text) this.scheduleEdit(); // reconcile to the latest text
    } catch (err) {
      this.disabled = true;
      this.warn(`status post failed: ${String(err)}`);
    }
  }

  private scheduleEdit(): void {
    if (this.disabled || this.stopped) return;
    if (this.editTimer) return;
    const interval = this.opts.editIntervalMs ?? 800;
    this.editTimer = setTimeout(() => {
      this.editTimer = undefined;
      const p = this.flushEdit().finally(() => {
        if (this.editing === p) this.editing = undefined;
      });
      this.editing = p;
    }, interval);
  }

  private async flushEdit(): Promise<void> {
    const b = this.active;
    if (this.disabled || this.stopped || !b || !b.posted || b.id === undefined || !this.target) {
      return;
    }
    try {
      await this.opts.status.edit(this.target, b.id, b.text);
    } catch (err) {
      this.warn(`status edit failed: ${String(err)}`);
    }
  }

  /** End the turn: drop all transient bubbles, then post the answer (one line per message). */
  async finish(reply: string): Promise<void> {
    await this.teardown();
    if (this.opts.send && this.target) await sendLines(this.opts.send, this.target, reply);
  }

  /** End the turn with no answer (error/interrupt): just drop the transient bubbles. */
  async stop(): Promise<void> {
    await this.teardown();
  }

  private async teardown(): Promise<void> {
    this.stopped = true;
    if (this.delayTimer) {
      clearTimeout(this.delayTimer);
      this.delayTimer = undefined;
    }
    if (this.editTimer) {
      clearTimeout(this.editTimer);
      this.editTimer = undefined;
    }
    await this.posting?.catch(() => undefined);
    await this.editing?.catch(() => undefined);
    for (const b of this.bubbles) {
      if (b.posted && b.id !== undefined) await this.safeRemove(b.id);
    }
  }

  private async safeRemove(id: string): Promise<void> {
    if (!this.target) return;
    try {
      await this.opts.status.remove(this.target, id);
    } catch (err) {
      this.warn(`status remove failed: ${String(err)}`);
    }
  }
}
```

> 注意：`import type { ChatTarget }` 与 `AgentProgress` 的导入保持不变（文件顶部已有）。

- [ ] **Step 4: 运行，确认通过 + 全量**

Run: `npx vitest run test/status.test.ts && npx tsc --noEmit && npx vitest run`
Expected: PASS（含既有的 `formatProgress` 测试）

- [ ] **Step 5: 提交**

```bash
git add src/reply/status.ts test/status.test.ts
git commit -m "feat(chat): rotating status bubbles + per-line final answer"
```

---

### Task 3: Router 接线（finish / 按行发）

**Files:**
- Modify: `src/router/router.ts`
- Test: `test/router.test.ts`

**Interfaces:**
- Consumes: `StatusReporter.finish/stop`、`sendLines`

- [ ] **Step 1: 写失败测试**（追加到 `test/router.test.ts`）

```ts
it("without a status transport, a multi-line reply is sent one message per line", async () => {
  const run = vi.fn(async () => "第一行\n\n第二行");
  const send = vi.fn(async () => {});
  const r = new Router({ botName: "ai", run, send });
  await r.handle(ev({ isDirect: true, text: "hi" }));
  expect(send).toHaveBeenCalledTimes(2);
  expect(send).toHaveBeenNthCalledWith(1, expect.anything(), "第一行");
  expect(send).toHaveBeenNthCalledWith(2, expect.anything(), "第二行");
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run test/router.test.ts`
Expected: FAIL（当前只发一条整段）

- [ ] **Step 3: 实现**（`src/router/router.ts`）

3a. 顶部导入加 `sendLines`：

```ts
import { StatusReporter, sendLines, type StatusTransport } from "../reply/status.js";
```

3b. 构造 reporter 时把 `send` 传进去（让 `finish` 能发答案）：

```ts
    const reporter = this.deps.status
      ? new StatusReporter({ status: this.deps.status, send: (t, x) => this.deps.send(t, x), delayMs: this.deps.statusDelayMs })
      : undefined;
```

3c. 收尾逻辑改为：

```ts
    if (errorMsg !== undefined) {
      await reporter?.stop();
      await this.deps.send(target, `⚠️ agent error: ${errorMsg}`);
    } else if (reply !== undefined && reply.trim().length > 0) {
      if (reporter) await reporter.finish(reply);
      else await sendLines(this.deps.send, target, reply);
    } else {
      await reporter?.stop();
    }
```

（即：成功且有 reporter → `finish`（删中间条 + 按行发）；成功无 reporter → 自己按行发；错误/空 → `stop` 删中间条。）

- [ ] **Step 4: 运行，确认通过 + 全量**

Run: `npx vitest run test/router.test.ts && npx tsc --noEmit && npx vitest run`
Expected: PASS（既有两个 status 测试应仍通过：首条 post=🧠、一次合并 edit、一次 remove、`send("the answer")`）

- [ ] **Step 5: 提交**

```bash
git add src/router/router.ts test/router.test.ts
git commit -m "feat(chat): router drives reporter.finish + per-line fallback"
```

---

### Task 4: 文档 + 部署 + 实机验证

**Files:**
- Modify: `docs/RUNBOOK.md`、`CLAUDE.md`

- [ ] **Step 1: 文档**

- `RUNBOOK.md`：更新「实时工具反馈」段——现在一条气泡会先显示 🧠/⏳，**模型一输出正文就原地变成正文**（旁白）；出正文后**再调工具才另开**一条新气泡；回合结束**中间气泡全部撤回，只留最终答案**（**按行拆成多条消息**）。`TOOL_STATUS=false` 时无气泡，答案仍按行发。
- `CLAUDE.md`：Key facts 补一条——`AgentProgress` 有 `narration`；`pi-session` 用 `TextSegmenter` 把"工具前正文"分段（答案 = 末段）；`StatusReporter` 是**轮转气泡**（`finish(reply)` 删中间条 + `sendLines` 按行发）。

- [ ] **Step 2: 构建 + 部署**

```bash
npm run build && docker build -t anytype-ai-bot:latest .
cd /home/landspace/anytype && docker compose -f docker-compose.yml -f /home/landspace/anytype-ai-bot/docker-compose.bot.yml up -d --force-recreate --no-deps ai-bot
```

- [ ] **Step 3: 实机验证（dev-test）**

在 `dev-test` 里让 bot 做一个**多步任务**（如"先搜一下 X，再读一篇，最后用 3 行总结"）：
1. 运行中应看到：`🧠 思考中…` →（原地变）`我先查一下…`（旁白）→ `⏳ 正在 anytype_search…`（**新气泡**）→ …
2. 回合结束：**中间气泡消失**，只剩最终答案，且**每行一条消息**。
3. 一个快回合（如"你好"）：无气泡闪现，答案按行发。
`docker logs --tail 40 anytype-ai-bot-1`

- [ ] **Step 4: 提交**

```bash
git add docs/RUNBOOK.md CLAUDE.md
git commit -m "docs: chat narration streaming + per-line bubbles"
```

---

## 自检记录

- **Spec 覆盖**：§3.1 分段 → T1；§3.2 轮转气泡 → T2；§3.3 finish/按行 → T2+T3；§3.4 接口/Router → T1（narration）+ T3；§6 测试 → 各任务测试步 + T4 实机。未覆盖项：无。
- **占位符扫描**：无 TBD；T2 给了完整类实现；T1 给了完整 `TextSegmenter`；T3 给了完整收尾分支。
- **一致性**：`AgentProgress.narration`、`TextSegmenter.{push,narration,answer}`、`sendLines`/`splitLines`、`MessageSender`、`StatusReporter.finish/stop` 全链一致；`StatusReporterOptions.send` 在 T2 声明、T3 使用。
- **风险**：既有两个 router status 测试依赖"首条 post=🧠 占位、后续走 edit"——T2 实现里**首个气泡的 post 文本固定为 `STATUS_PLACEHOLDER`**、其余文本走 edit，正是为保持该行为；T3 的 `finish` 用 `remove` 帮其通过。若测试因计时微差不过，按上述语义微调 fake 时序而非改语义。
