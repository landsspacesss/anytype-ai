# 控制台派 worker 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 控制台（1:1）在**解锁**后能派**一次性 worker** 到**目标空间**，worker 在**该空间的工作区**里读写该空间。

**Architecture:** 控制台的"锁"是一个 per-chat 的 `consoleUnlocked` 布尔（默认锁）。锁定时 `effectiveToolNames` 给控制台只给 `CONSOLE_TOOLS`；解锁时**多加** `anytype_run_in_space`（工具本身由 `createAnytypeTools` 在 console dep 下注册，激活与否由工具集控制——注意"注册≠激活"这个坑）。`anytype_run_in_space(space, task)` 的实现（在 pi-session 内）起一个**一次性子会话**，参数化为目标 `spaceId` + cwd=`/workspace/<目标space>`，工具=全量（无 `subagent`/`agent`）、无批准闸门。控制台**自身工具永远只读**。

**Tech Stack:** TypeScript (NodeNext, strict)、vitest、内嵌 pi SDK。

## Global Constraints

- 脚本：`npm run build`（tsc）、`npm test`（vitest run）；单文件 `npx vitest run test/<f>.test.ts`。
- **控制台自身工具永远只读**：`CONSOLE_TOOLS` 已无任何写工具；本功能**不**给它加写工具，只加 `anytype_run_in_space`（它本身不写，是"派活"）。
- **默认锁定**：`consoleUnlocked` 默认 `false`；只有 `/yolo auto`（控制台）解锁。
- **worker 只能写目标空间**；worker **不含** `subagent`/`agent`（不递归）；worker **不过**批准闸门（解锁=显式授权）。
- **worker 每次全新**（一次性），持久化落 `/workspace/<目标space>`（该空间 AGENTS.md/MEMORY.md）。
- **注册 ≠ 激活**：工具被 `createAnytypeTools` 注册后，仍需在 `effectiveToolNames` 的输出里才会被 `setActiveToolsByName` 激活；锁定时必须**不在**激活集里（否则模型能派 worker）。
- 提交信息英文，风格 `feat:/fix:/docs:/test:`。
- 实机验证用 `docker run`/重建 bot。

## 文件结构

| 文件 | 责任 |
|---|---|
| `src/agent/pi-session.ts`（改） | `effectiveToolNames` 增 `consoleUnlocked`；`applyTools` 用锁；`setConsoleUnlocked/isConsoleUnlocked`；`createChildAgent(opts)` 参数化；`runInSpace`；console dep 注入 `runInSpace` |
| `src/agent/anytype-tools.ts`（改） | console dep 增 `runInSpace?`；新工具 `anytype_run_in_space` |
| `src/session/manager.ts`（改） | `ManagedClient` 加 `setConsoleUnlocked?/isConsoleUnlocked?`；SessionManager per-chat 锁 + `getConsoleUnlocked/setConsoleUnlocked` |
| `src/commands/handler.ts`（改） | 控制台 `/yolo` → 解锁/锁定；`CommandContext` 加 `getConsoleUnlocked/setConsoleUnlocked` |
| `src/main.ts`（改） | console client 传 `consoleUnlocked`；`CommandContext` 接锁方法 |

---

### Task 1: 控制台工具集门控（pi-session）

**Files:**
- Modify: `src/agent/pi-session.ts`
- Test: `test/pi-session.test.ts`

**Interfaces:**
- Produces:
  - `effectiveToolNames(o: { isConsole: boolean; mode: ApprovalMode; allToolNames: string[]; consoleUnlocked?: boolean }): string[]`
  - `ManagedClient.setConsoleUnlocked?(on: boolean): boolean`、`isConsoleUnlocked?(): boolean`
  - `PiClientOptions.consoleUnlocked?: boolean`

- [ ] **Step 1: 写失败测试**（追加到 `test/pi-session.test.ts`）

```ts
describe("effectiveToolNames — console lock", () => {
  const all = ["read", "anytype_create_note", "anytype_run_in_space"];
  it("console LOCKED → CONSOLE_TOOLS only, no worker tool", () => {
    const names = effectiveToolNames({ isConsole: true, mode: "auto", allToolNames: all, consoleUnlocked: false });
    expect(names).toContain("anytype_list_spaces");
    expect(names).not.toContain("anytype_run_in_space");
    expect(names).not.toContain("anytype_create_note");
  });
  it("console UNLOCKED → CONSOLE_TOOLS + worker tool, still no writers", () => {
    const names = effectiveToolNames({ isConsole: true, mode: "auto", allToolNames: all, consoleUnlocked: true });
    expect(names).toContain("anytype_list_spaces");
    expect(names).toContain("anytype_run_in_space");
    expect(names).not.toContain("anytype_create_note");
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run test/pi-session.test.ts`
Expected: FAIL（`consoleUnlocked` 无效 / 断言失败）

- [ ] **Step 3: 实现**

3a. `effectiveToolNames` 改：

```ts
/** Effective tool names for a session.
 *  - console → always read-only (CONSOLE_TOOLS); + the worker tool when UNLOCKED
 *  - auto / ask → all tools (ask blocks via the gate, not the tool set)
 *  - readonly → safe tools + subagents (children inherit safe-only)
 */
export function effectiveToolNames(o: {
  isConsole: boolean;
  mode: ApprovalMode;
  allToolNames: string[];
  consoleUnlocked?: boolean;
}): string[] {
  if (o.isConsole) {
    return [...CONSOLE_TOOLS, ...(o.consoleUnlocked ? ["anytype_run_in_space"] : [])];
  }
  if (o.mode === "readonly") return [...SAFE_TOOLS, "subagent", "agent"];
  return [...o.allToolNames];
}
```

3b. `PiClientOptions` 加：

```ts
  /** Console only: whether the console is unlocked (may dispatch workers). Default false. */
  consoleUnlocked?: boolean;
```

3c. 在 `applyTools` 前加 `let consoleUnlocked = opts.consoleUnlocked === true;`，并把 `applyTools` 里的调用改成带上锁：

```ts
  const applyTools = (): void => {
    session.setActiveToolsByName(
      effectiveToolNames({
        isConsole: opts.isConsole === true,
        mode: approvalMode,
        allToolNames: session.getAllTools().map((t) => t.name),
        consoleUnlocked,
      }),
    );
  };
```

3d. 返回对象里加（放在 `isAutoTools` 附近）：

```ts
    setConsoleUnlocked(on: boolean): boolean {
      if (opts.isConsole !== true) return false; // normal sessions have no console lock
      consoleUnlocked = on;
      applyTools();
      return consoleUnlocked;
    },
    isConsoleUnlocked(): boolean {
      return opts.isConsole === true && consoleUnlocked;
    },
```

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run test/pi-session.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/agent/pi-session.ts test/pi-session.test.ts
git commit -m "feat(console): worker tool gated on the console lock"
```

---

### Task 2: 参数化子会话 + `runInSpace`（pi-session）

**Files:**
- Modify: `src/agent/pi-session.ts`
- Test: 编译 + 实机（`createChildAgent` 需真 SDK，无单测）

**Interfaces:**
- Consumes: `ensureAgentFiles`（同文件导出）、`resolveSpaceId`（`src/agent/anytype-tools.ts` 已导出）
- Produces:
  - `createChildAgent(opts?: { spaceId?: string; cwd?: string; readOnly?: boolean }): Promise<ChildAgent>`
  - console dep 里新增 `runInSpace?: (space: string, task: string) => Promise<string>`

- [ ] **Step 1: 实现**

1a. 顶部导入 `resolveSpaceId`：

```ts
import { createAnytypeTools, resolveSpaceId } from "./anytype-tools.js";
```

1b. `createChildAgent` 参数化（把固定的 `opts.cwd` / `opts.spaceId` 换成参数）：

```ts
  const createChildAgent = async (
    child: { spaceId?: string; cwd?: string; readOnly?: boolean } = {},
  ): Promise<ChildAgent> => {
    const childSpace = child.spaceId ?? opts.spaceId;
    const childCwd = child.cwd ?? opts.cwd;
    const { session: childSession } = await createAgentSession({
      cwd: childCwd,
      agentDir: opts.agentDir,
      authStorage,
      modelRegistry,
      sessionManager: SessionManager.inMemory(),
      customTools: createAnytypeTools({
        api: opts.api, spaceId: childSpace, workspaceDir: childCwd, store: opts.store,
        chatId: opts.chatId, defaultWatchCron: opts.defaultWatchCron ?? DEFAULT_WATCH_CRON,
        searchApiKey: opts.searchApiKey ?? "", searchModel: opts.searchModel,
        lightpandaBin: opts.lightpandaBin, webFetchTimeoutMs: opts.webFetchTimeoutMs,
        webFetchMaxChars: opts.webFetchMaxChars,
        // NOTE: no runSubagent/agentRegistry → no recursion.
      }),
      ...(model ? { model: model as never } : {}),
    });
    // Children are read-only when the parent is readonly, or when explicitly asked.
    if (child.readOnly || approvalMode === "readonly") {
      childSession.setActiveToolsByName([...SAFE_TOOLS]);
    }
    let collected = "";
    const unsub = childSession.subscribe((e) => {
      if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") {
        collected += e.assistantMessageEvent.delta;
      }
    });
    return {
      get busy(): boolean { return childSession.isStreaming; },
      async prompt(text: string): Promise<string> { collected = ""; await childSession.prompt(text); return collected; },
      dispose(): void { unsub(); childSession.dispose(); },
    };
  };
```

> 注意：原实现里返回对象内部用了变量名 `child`（`child.isStreaming` 等）。把会话变量重命名为 `childSession` 以避免与参数 `child` 冲突，并同步改返回对象里的引用。

1c. 新增 `runInSpace`（一次性 worker，绑目标空间）：

```ts
  /**
   * One-shot WORKER bound to a TARGET space: runs `task` in that space's
   * workspace (its AGENTS.md/MEMORY.md) with the full tool set (minus
   * subagent/agent, so no recursion), then disposes. `space` may be an id or
   * a name. Only the console uses this.
   */
  const runInSpace = async (space: string, task: string): Promise<string> => {
    if (!opts.agentWorkspaceRoot) throw new Error("runInSpace: agentWorkspaceRoot not set");
    const spaceId = await resolveSpaceId(opts.api, space, opts.spaceId);
    const cwd = path.join(opts.agentWorkspaceRoot, spaceId);
    ensureAgentFiles(cwd); // seed that space's AGENTS.md/MEMORY.md contract
    const a = await createChildAgent({ spaceId, cwd });
    try {
      return await a.prompt(task);
    } finally {
      a.dispose();
    }
  };
```

1d. 顶层 `createAnytypeTools` 的 console dep 里注入 `runInSpace`（在现有 `...(opts.isConsole ? { console: {...} } : {})` 里）：

```ts
      ...(opts.isConsole
        ? {
            console: {
              workspaceRoot: opts.agentWorkspaceRoot!,
              ...(opts.console?.joinSpace ? { joinSpace: opts.console.joinSpace } : {}),
              runInSpace,
            },
          }
        : {}),
```

- [ ] **Step 2: 编译 + 全量**

Run: `npx tsc --noEmit && npm run build && npx vitest run`
Expected: 全绿（注意：`effectiveToolNames` 的调用点已带 `consoleUnlocked`；子会话构造点同步改名）

- [ ] **Step 3: 提交**

```bash
git add src/agent/pi-session.ts
git commit -m "feat(console): parameterized child sessions + runInSpace worker"
```

---

### Task 3: `anytype_run_in_space` 工具

**Files:**
- Modify: `src/agent/anytype-tools.ts`
- Test: `test/console-tools.test.ts`

**Interfaces:**
- Consumes: console dep（Task 2 注入 `runInSpace`）
- Produces: 工具 `anytype_run_in_space`（仅 `consoleDep?.runInSpace` 存在时注册）

- [ ] **Step 1: 写失败测试**（追加到 `test/console-tools.test.ts`）

```ts
it("anytype_run_in_space registered only with a console runInSpace", () => {
  const noRun = createAnytypeTools(baseDeps(fakeApi(), true)); // console dep w/o runInSpace
  expect(toolNames(noRun)).not.toContain("anytype_run_in_space");

  const runInSpace = vi.fn(async () => "done");
  const deps = { ...baseDeps(fakeApi(), false), console: { workspaceRoot: "/tmp/ws", runInSpace } };
  const tools = createAnytypeTools(deps);
  expect(toolNames(tools)).toContain("anytype_run_in_space");
});

it("anytype_run_in_space forwards space + task and returns the result", async () => {
  const runInSpace = vi.fn(async (s: string, t: string) => `ran ${t} in ${s}`);
  const deps = { ...baseDeps(fakeApi(), false), console: { workspaceRoot: "/tmp/ws", runInSpace } };
  const t = createAnytypeTools(deps).find((x) => x.name === "anytype_run_in_space")!;
  const text = ((await t.execute("id", { space: "考试", task: "整理" })).content[0] as { text: string }).text;
  expect(runInSpace).toHaveBeenCalledWith("考试", "整理");
  expect(text).toContain("ran 整理 in 考试");
});

it("anytype_run_in_space requires a task", async () => {
  const runInSpace = vi.fn();
  const deps = { ...baseDeps(fakeApi(), false), console: { workspaceRoot: "/tmp/ws", runInSpace } };
  const t = createAnytypeTools(deps).find((x) => x.name === "anytype_run_in_space")!;
  const text = ((await t.execute("id", { space: "x" })).content[0] as { text: string }).text;
  expect(runInSpace).not.toHaveBeenCalled();
  expect(text).toMatch(/task/);
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run test/console-tools.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

3a. console dep 类型扩展：

```ts
  console?: {
    workspaceRoot: string;
    joinSpace?: (link: string) => Promise<{ ok: boolean; message: string }>;
    /** Run a one-shot worker bound to a target space; returns its final text. */
    runInSpace?: (space: string, task: string) => Promise<string>;
  };
```

3b. 新增工具（放在 `joinSpace` 工具定义之后）：

```ts
  const runInSpaceTool = defineTool({
    name: "anytype_run_in_space",
    label: "Run a task in another space",
    description:
      "Dispatch a ONE-SHOT worker bound to a TARGET space (by id or name) that runs `task` inside that space's own context/memory and can read AND write it. Use it to delegate a writing/org task to a specific space without cluttering this conversation. The worker does not see this conversation, so `task` must be self-contained. Only available in an UNLOCKED console.",
    promptSnippet: "anytype_run_in_space — delegate a task to another space's worker (reads+writes it)",
    promptGuidelines: GUIDELINES,
    parameters: Type.Object({
      space: Type.String({ description: "Target space id or name." }),
      task: Type.String({ description: "A self-contained task for the worker." }),
    }),
    async execute(_id, params) {
      if (!consoleDep?.runInSpace) return textResult("anytype_run_in_space unavailable in this session.");
      const task = typeof params.task === "string" ? params.task.trim() : "";
      if (!params.space || task.length === 0) {
        return textResult("anytype_run_in_space: provide `space` and a non-empty `task`.");
      }
      try {
        return textResult(await consoleDep.runInSpace(params.space, task));
      } catch (err) {
        return textResult(`anytype_run_in_space failed: ${errMessage(err)}`);
      }
    },
  });
```

3c. 组装：把现有 console push 改为在 `runInSpace` 存在时也加它：

```ts
  if (consoleDep) tools.push(listSpaces, memories, joinSpace);
  if (consoleDep?.runInSpace) tools.push(runInSpaceTool);
```

- [ ] **Step 4: 运行，确认通过 + 全量**

Run: `npx vitest run test/console-tools.test.ts && npx tsc --noEmit && npx vitest run`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/agent/anytype-tools.ts test/console-tools.test.ts
git commit -m "feat(console): anytype_run_in_space (delegate to a target space's worker)"
```

---

### Task 4: SessionManager 控制台锁（per-chat）

**Files:**
- Modify: `src/session/manager.ts`
- Test: `test/session-manager.test.ts`

**Interfaces:**
- Consumes: `ManagedClient.setConsoleUnlocked?/isConsoleUnlocked?`（Task 1）
- Produces: `SessionManager.getConsoleUnlocked(chatId): boolean`、`setConsoleUnlocked(chatId, on): boolean`

- [ ] **Step 1: 写失败测试**（追加到 `test/session-manager.test.ts`）

```ts
it("remembers the console lock per chat and applies it to a live client", async () => {
  const setLock = vi.fn((on: boolean) => on);
  const createClient = vi.fn(async () => ({
    get busy() { return false; },
    async prompt() { return "ok"; },
    async close() {}, async abort() {},
    setConsoleUnlocked: setLock, isConsoleUnlocked: () => false,
  }));
  const mgr = new SessionManager({ createClient, maxConcurrent: 3, idleMs: 100000 });
  expect(mgr.getConsoleUnlocked("c1")).toBe(false); // default locked
  await mgr.ensure("c1");
  expect(mgr.setConsoleUnlocked("c1", true)).toBe(true);
  expect(setLock).toHaveBeenLastCalledWith(true);
  expect(mgr.getConsoleUnlocked("c1")).toBe(true);
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run test/session-manager.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

3a. `ManagedClient` 接口加：

```ts
  /** Console only: set whether the console is unlocked (may dispatch workers). */
  setConsoleUnlocked?(on: boolean): boolean;
  /** Console only: whether the console is unlocked. */
  isConsoleUnlocked?(): boolean;
```

3b. `SessionManager` 加私有 map 与方法（仿 `policies`）：

```ts
  private consoleLocks = new Map<string, boolean>();

  /** Whether this chat's console is unlocked (false when it isn't a console). */
  getConsoleUnlocked(chatId: string): boolean {
    return this.consoleLocks.get(chatId) ?? this.entries.get(chatId)?.client.isConsoleUnlocked?.() ?? false;
  }

  /** Set the console lock; applies to a live client. No-op (false) for non-consoles. */
  setConsoleUnlocked(chatId: string, on: boolean): boolean {
    const e = this.entries.get(chatId);
    if (e && e.client.setConsoleUnlocked && !e.client.setConsoleUnlocked(on)) {
      return this.getConsoleUnlocked(chatId); // client refused (not a console)
    }
    this.consoleLocks.set(chatId, on);
    return on;
  }
```

3c. 客户端创建处（`client.setApprovalMode?.(...)` 附近）加：

```ts
    client.setConsoleUnlocked?.(this.getConsoleUnlocked(chatId));
```

- [ ] **Step 4: 运行，确认通过 + 全量**

Run: `npx vitest run test/session-manager.test.ts && npx tsc --noEmit && npx vitest run`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/session/manager.ts test/session-manager.test.ts
git commit -m "feat(console): per-chat console lock in SessionManager"
```

---

### Task 5: `/yolo` 控制台解锁/锁定（handler）

**Files:**
- Modify: `src/commands/handler.ts`
- Test: `test/commands-handler.test.ts`

**Interfaces:**
- Consumes: `CommandContext.getConsoleUnlocked/setConsoleUnlocked`（main 提供）
- Produces: `CommandContext.getConsoleUnlocked(): boolean`、`setConsoleUnlocked(on: boolean): boolean`；`/yolo` 控制台分支

- [ ] **Step 1: 写失败测试**（追加到 `test/commands-handler.test.ts`；并在 `ctx()` 里补两个方法）

在 `ctx()` 里加：

```ts
  let unlocked = false;
  const getConsoleUnlocked = () => unlocked;
  const setConsoleUnlocked = vi.fn((on: boolean) => { unlocked = on; return on; });
```

并塞进 `context`，且 `ctx()` 一并返回 `setConsoleUnlocked`。

新增测试：

```ts
it("/yolo auto on the console unlocks it (may dispatch workers)", async () => {
  const { context, setConsoleUnlocked } = ctx(fakeClient());
  const reply = await handleCommand("yolo", "auto", { ...context, isConsole: true });
  expect(setConsoleUnlocked).toHaveBeenCalledWith(true);
  expect(reply).toMatch(/解锁/);
});
it("/yolo readonly on the console locks it", async () => {
  const { context, setConsoleUnlocked } = ctx(fakeClient());
  const reply = await handleCommand("yolo", "readonly", { ...context, isConsole: true });
  expect(setConsoleUnlocked).toHaveBeenCalledWith(false);
  expect(reply).toMatch(/锁定/);
});
it("/yolo (no arg) on the console reports lock state and does not change it", async () => {
  const { context, setConsoleUnlocked } = ctx(fakeClient());
  const reply = await handleCommand("yolo", "", { ...context, isConsole: true });
  expect(setConsoleUnlocked).not.toHaveBeenCalled();
  expect(reply).toMatch(/锁定|解锁/);
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run test/commands-handler.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

3a. `CommandContext` 加两方法：

```ts
  /** Console only: whether the console is unlocked (may dispatch workers). */
  getConsoleUnlocked(): boolean;
  /** Console only: set the console lock; returns the applied value. */
  setConsoleUnlocked(on: boolean): boolean;
```

3b. 替换 `case "yolo":` **开头**加控制台分支（放在现有非控制台逻辑之前）：

```ts
    case "yolo": {
      // The console has no approval mode — its own tools are always read-only.
      // /yolo here just LOCKS/UNLOCKS the ability to dispatch workers.
      if (ctx.isConsole) {
        if (!args) {
          return `控制台：${ctx.getConsoleUnlocked() ? "已解锁（可派 worker 到其它空间）" : "锁定（只读，不能派 worker）"}`;
        }
        const a = args.toLowerCase();
        if (a === "auto" || a === "on") {
          ctx.setConsoleUnlocked(true);
          return "控制台已解锁：可派 worker 到其它空间（写入由该 worker 执行）。";
        }
        if (a === "readonly" || a === "ro" || a === "ask" || a === "off") {
          ctx.setConsoleUnlocked(false);
          return "控制台已锁定：只读，不能派 worker。";
        }
        return `用法：/yolo auto|readonly（控制台：auto=解锁，readonly=锁定）`;
      }
      // …（既有的非控制台三态逻辑不变）
```

3c. `HELP_TEXT` 的 `/yolo` 行补一句控制台语义（可选）——在现有行尾加「（控制台：auto=解锁派 worker，readonly=锁定）」。

- [ ] **Step 4: 运行，确认通过 + 全量**

Run: `npx vitest run test/commands-handler.test.ts && npx tsc --noEmit && npx vitest run`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/commands/handler.ts test/commands-handler.test.ts
git commit -m "feat(console): /yolo locks/unlocks the console (enables workers)"
```

---

### Task 6: main.ts 接线

**Files:**
- Modify: `src/main.ts`
- Test: 编译 + 实机

**Interfaces:**
- Consumes: Task 4/5 的方法

- [ ] **Step 1: 实现**

1a. `createClient` 里给 `createPiClient` 传当前锁状态（放在 `approvalMode:` 附近）：

```ts
        // Console lock (unlocked by /yolo auto): gates whether the console can
        // dispatch workers. Normal sessions ignore it.
        consoleUnlocked: sessions.getConsoleUnlocked(chatId),
```

1b. `CommandContext` 对象里加：

```ts
            getConsoleUnlocked: () => sessions.getConsoleUnlocked(e.chatId),
            setConsoleUnlocked: (on) => sessions.setConsoleUnlocked(e.chatId, on),
```

> 注意：`console` dep（`main.ts` 里给 `createPiClient` 的 `{ workspaceRoot, joinSpace }`）**不用**加 `runInSpace`——那是 pi-session 自己注入的。

- [ ] **Step 2: 编译 + 全量**

Run: `npx tsc --noEmit && npm run build && npx vitest run`
Expected: 全绿

- [ ] **Step 3: 提交**

```bash
git add src/main.ts
git commit -m "feat(console): wire the console lock (main)"
```

---

### Task 7: 文档 + 部署 + 实机验证

**Files:**
- Modify: `docs/RUNBOOK.md`、`CLAUDE.md`、`README.zh-CN.md`

- [ ] **Step 1: 文档**

- `RUNBOOK.md`：更新 `/yolo` 行 + 控制台一节——**控制台自身只读；`/yolo auto` 解锁后可派 worker（`anytype_run_in_space`）到目标空间；`/yolo readonly` 锁定**。加一句：worker 在**目标空间的工作区/记忆**里跑、**只能写那个空间**、**不递归**。
- `CLAUDE.md`：Key facts 加一条——控制台锁（`consoleUnlocked`）门控 `anytype_run_in_space`；worker 是参数化的子会话（绑目标 spaceId + `/workspace/<space>`），注册与激活分离（注册≠激活）。
- `README.zh-CN.md`：控制台 bullet 补一句「解锁后可把写任务派给目标空间的 worker」。

- [ ] **Step 2: 构建 + 部署**

```bash
npm run build && docker build -t anytype-ai-bot:latest .
cd /home/landspace/anytype && docker compose -f docker-compose.yml -f /home/landspace/anytype-ai-bot/docker-compose.bot.yml up -d --force-recreate --no-deps ai-bot
```

- [ ] **Step 3: 实机验证（在 1:1 控制台里）**

1. 默认（锁定）：让控制台「去 dev-test 新建一篇 XX」→ 它**没有** `anytype_run_in_space`，应说明做不到 / 只能给建议。
2. `/yolo auto` → 「控制台已解锁」。
3. 再让它「去 dev-test 新建一篇测试笔记，标题 XX」→ 应派出 worker、**在 dev-test 生成**该笔记；控制台对话**不被中间过程污染**（只有最终结果）。
4. 让它同时派两个不同空间的 worker → 都落到各自空间（并行/隔离）。
5. `/yolo readonly` → 锁定；再让它派 → 不行。
6. 确认控制台**自己**仍无任何写工具（让它直接建页面 → 无工具）。
`docker logs --tail 40 anytype-ai-bot-1`

- [ ] **Step 4: 提交**

```bash
git add docs/RUNBOOK.md CLAUDE.md README.zh-CN.md
git commit -m "docs: console workers (unlock + anytype_run_in_space)"
```

---

## 自检记录

- **Spec 覆盖**：§1 锁/恢复 /yolo → T1+T4+T5；§2 角色（控制台只读、worker 可写/目标空间/不递归/一次性）→ T2（worker）+ T3（工具）+ T1（控制台只读不变）；§3 工具 → T3；§4 组件 → 各 Task Files；§5 数据流 → T2+T6；§6 边界 → T1（默认锁）+ T2（无 subagent）；§7 测试 → 各 Task 测试 + T7 实机。未覆盖项：无。
- **类型一致**：`consoleUnlocked`、`setConsoleUnlocked/isConsoleUnlocked`、`anytype_run_in_space`、`runInSpace(space,task)`、`getConsoleUnlocked/setConsoleUnlocked`（Client 与 SessionManager 同名）全链一致。
- **风险**：T2 的 `createChildAgent` 需把局部会话变量从 `child` 改名 `childSession`（避免与参数 `child` 冲突）——实现时同步改返回对象里的引用。T1/T2 都要保证"注册≠激活"：锁定时 `anytype_run_in_space` **不在** `effectiveToolNames` 输出里。
