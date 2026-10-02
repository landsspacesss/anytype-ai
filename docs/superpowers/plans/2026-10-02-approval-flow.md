# 批准流（Approval Flow）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 pi 的 `tool_call` 钩子做真正的批准流——`ask` 模式下写操作前在聊天里问用户，`/approve`/`/approve all`/`/deny` 决定，超时默认拒绝。

**Architecture:** 三态 `ApprovalMode`（`auto`/`ask`/`readonly`）per-chat。`src/agent/approval.ts` 提供纯状态机 `ApprovalGate` 与工具分类 `SAFE_TOOLS`/`needsApproval`。`pi-session.ts` 给顶层会话注入一个 `DefaultResourceLoader({ extensionFactories })`，其 `on("tool_call")` 处理器在 `ask` 模式下 awaited 拦截非安全工具（返回 `{block:true}`）。命令经 SessionManager 解开待批准。控制台不变（恒只读、无 subagent）。

**Tech Stack:** TypeScript (NodeNext, strict)、vitest、内嵌 pi SDK（`@earendil-works/pi-coding-agent`）。

## Global Constraints

- 脚本：`npm run build`（tsc）、`npm test`（vitest run）；单文件 `npx vitest run test/<f>.test.ts`。
- **不删任何工具**：模式只改变"闸门开关 / 子会话工具集"，不改变注册面（控制台的 `CONSOLE_TOOLS` 除外——不变）。
- **`ask` 模式**：非 `SAFE_TOOLS` 的工具→问用户；`subagent`/`agent`→**直接 block 并提示**（不询问）。
- **`readonly` 模式**：工具集 = `SAFE_TOOLS` + `subagent`/`agent`；**子会话 = `SAFE_TOOLS`**（不可写）。
- **`auto` 模式**：全部工具，无闸门（普通空间新会话默认）。
- **控制台恒 `readonly`**，`/yolo` 在控制台仍无效；控制台工具集 = `CONSOLE_TOOLS`（不含 subagent）——**不改**。
- 超时默认**拒绝**（`APPROVAL_TIMEOUT_MS` 默认 300000）。
- 未知/新工具**默认从严**（不在 `SAFE_TOOLS` → 需批准）。
- 提交信息英文，风格 `feat:/fix:/docs:/test:`。
- 实机验证用 `docker run` 新镜像 / 重建 bot；`docker exec` 进旧容器测的是旧代码。

## 文件结构

| 文件 | 责任 |
|---|---|
| `src/agent/approval.ts`（新） | `ApprovalMode`、`SAFE_TOOLS`、`needsApproval`、`ApprovalGate`（纯状态机） |
| `src/agent/pi-session.ts`（改） | `effectiveToolNames` 三态；顶层会话注入扩展闸门；`readonly` 子会话只读；`setApprovalMode/getApprovalMode/approvePending` |
| `src/session/manager.ts`（改） | `ManagedClient` 三个可选方法；per-chat 模式持久化（仿 `policies`）；`SessionManager` 的同名方法 |
| `src/commands/handler.ts`（改） | `/yolo auto\|ask\|readonly`（+`on`/`off` 别名）；`/approve`、`/approve all`、`/deny`；`CommandContext` 扩展；`HELP_TEXT` |
| `src/config.ts` / `src/types.ts`（改） | `approvalTimeoutMs`、`approvalMode` |
| `src/main.ts`（改） | 接线（命令 ctx ↔ SessionManager；闸门 post → `api.sendMessage`；`createPiClient` 传 gate/模式） |

---

### Task 1: `ApprovalGate` 状态机 + 工具分类

**Files:**
- Create: `src/agent/approval.ts`
- Test: `test/approval.test.ts`

**Interfaces:**
- Produces:
  - `type ApprovalMode = "auto" | "ask" | "readonly"`
  - `const SAFE_TOOLS: ReadonlySet<string>`
  - `function needsApproval(tool: string): boolean`  — `!SAFE_TOOLS.has(tool) && tool !== "subagent" && tool !== "agent"`（子代理另行处理，不算"需批准")
  - `class ApprovalGate`
    - `constructor(opts: { timeoutMs: number; post: (text: string) => Promise<void> | void; describe?: (tool: string, args: unknown) => string; log?: (m: string) => void })`
    - `get approvedAll(): boolean`
    - `request(tool: string, args: unknown, signal?: AbortSignal): Promise<boolean>` — 已 all → true；否则发问并 await；超时/abort → 拒绝
    - `resolve(kind: "approve" | "all" | "deny"): boolean` — 无待批准返回 false
    - `resetTurn(): void` — 清 `approvedAll` 与任何待批准（按拒绝收尾）
    - `cancel(): void` — 待批准按拒绝收尾（用于回合结束）

- [ ] **Step 1: 写失败测试**

```ts
// test/approval.test.ts
import { describe, it, expect, vi } from "vitest";
import { ApprovalGate, SAFE_TOOLS, needsApproval } from "../src/agent/approval.js";

describe("tool classification", () => {
  it("SAFE_TOOLS are pure reads", () => {
    for (const t of ["read", "ls", "grep", "find", "anytype_read_object", "anytype_search", "web_search"]) {
      expect(SAFE_TOOLS.has(t)).toBe(true);
    }
    for (const t of ["bash", "write", "edit", "anytype_create_note", "anytype_delete_object", "anytype_send_message"]) {
      expect(SAFE_TOOLS.has(t)).toBe(false);
    }
  });

  it("needsApproval: unknown tools default to true; subagents are handled separately", () => {
    expect(needsApproval("anytype_create_note")).toBe(true);
    expect(needsApproval("bash")).toBe(true);
    expect(needsApproval("brand_new_tool")).toBe(true); // default-deny
    expect(needsApproval("anytype_read_object")).toBe(false);
    expect(needsApproval("read")).toBe(false);
    expect(needsApproval("subagent")).toBe(false); // not "approval"; blocked with a notice instead
    expect(needsApproval("agent")).toBe(false);
  });
});

describe("ApprovalGate", () => {
  function gate(timeoutMs = 1000) {
    const posted: string[] = [];
    const g = new ApprovalGate({ timeoutMs, post: (t) => { posted.push(t); } });
    return { g, posted };
  }

  it("approve allows the call", async () => {
    const { g, posted } = gate();
    const p = g.request("anytype_create_note", { name: "x" });
    await Promise.resolve(); // let it post
    expect(posted.length).toBe(1);
    expect(posted[0]).toContain("anytype_create_note");
    g.resolve("approve");
    expect(await p).toBe(true);
  });

  it("deny blocks the call", async () => {
    const { g } = gate();
    const p = g.request("anytype_create_note", {});
    await Promise.resolve();
    g.resolve("deny");
    expect(await p).toBe(false);
  });

  it("approve-all allows this and all later calls this turn", async () => {
    const { g } = gate();
    const p = g.request("anytype_create_note", {});
    await Promise.resolve();
    g.resolve("all");
    expect(await p).toBe(true);
    expect(g.approvedAll).toBe(true);
    // next call returns immediately without posting
    expect(await g.request("anytype_delete_object", {})).toBe(true);
  });

  it("timeout denies", async () => {
    const { g } = gate(10);
    expect(await g.request("anytype_create_note", {})).toBe(false);
  });

  it("abort denies", async () => {
    const { g } = gate(10000);
    const ac = new AbortController();
    const p = g.request("bash", { command: "rm -rf /" }, ac.signal);
    await Promise.resolve();
    ac.abort();
    expect(await p).toBe(false);
  });

  it("resolve with no pending request returns false", () => {
    const { g } = gate();
    expect(g.resolve("approve")).toBe(false);
  });

  it("resetTurn clears approvedAll", async () => {
    const { g } = gate();
    const p = g.request("anytype_create_note", {});
    await Promise.resolve();
    g.resolve("all");
    await p;
    g.resetTurn();
    expect(g.approvedAll).toBe(false);
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run test/approval.test.ts`
Expected: FAIL（`Cannot find module '../src/agent/approval.js'`）

- [ ] **Step 3: 实现**

```ts
// src/agent/approval.ts
/**
 * The three approval modes for a chat:
 * - `auto`     — never ask; every tool runs.
 * - `ask`      — a non-safe tool call posts a prompt and blocks until the user
 *                replies /approve, /approve all, or /deny (timeout → deny).
 * - `readonly` — no write tools at all (the classic safe set); sub-agents are
 *                allowed but inherit read-only, so they cannot write either.
 */
export type ApprovalMode = "auto" | "ask" | "readonly";

export function isApprovalMode(v: string): v is ApprovalMode {
  return v === "auto" || v === "ask" || v === "readonly";
}

/**
 * Tools that never need approval: pure local reads and read-only Anytype/web
 * reads. Everything else (writes, bash, sub-agents, unknown tools) is treated
 * as unsafe by default.
 */
export const SAFE_TOOLS: ReadonlySet<string> = new Set([
  "read", "ls", "grep", "find",
  "anytype_list_objects",
  "anytype_search",
  "anytype_read_object",
  "anytype_download_images",
  "anytype_download_file",
  "crop_image",
  "anytype_list_properties",
  "anytype_list_types",
  "anytype_templates",
  "web_search",
  "web_fetch",
  "anytype_watch",
]);

/**
 * Whether an `ask`-mode tool call needs the user's approval. Sub-agents are
 * NOT "approval" targets — they are refused outright in ask mode (see the
 * gate), so they return false here.
 */
export function needsApproval(tool: string): boolean {
  if (tool === "subagent" || tool === "agent") return false;
  return !SAFE_TOOLS.has(tool);
}

/** Default prompt line for a pending approval. */
export function describeApproval(tool: string, args: unknown): string {
  let hint = "";
  try {
    if (args !== undefined && args !== null) {
      hint = JSON.stringify(args).replace(/\s*\r?\n\s*/g, " ");
      if (hint.length > 80) hint = hint.slice(0, 80) + "…";
    }
  } catch {
    hint = "";
  }
  const call = hint ? `${tool}(${hint})` : tool;
  return `⚠️ 想执行 ${call}，回复 /approve、/approve all 或 /deny`;
}

type Decision = "approve" | "all" | "deny";

export interface ApprovalGateOptions {
  /** Milliseconds before a pending request is auto-DENIED. */
  timeoutMs: number;
  /** Post the approval prompt into the chat. */
  post: (text: string) => Promise<void> | void;
  /** Build the prompt text (defaults to `describeApproval`). */
  describe?: (tool: string, args: unknown) => string;
  /** Non-fatal warning sink. Defaults to console.warn. */
  log?: (m: string) => void;
}

/**
 * Single-chat approval state machine. `request()` is awaited by the tool-call
 * hook; `resolve()` is called from /approve|/approve all|/deny commands. Purely
 * synchronous state plus one promise — no timers leak past a settle.
 */
export class ApprovalGate {
  private pending?: { resolve: (d: Decision) => void; timer: ReturnType<typeof setTimeout> };
  private _approvedAll = false;
  private readonly describe: (tool: string, args: unknown) => string;

  constructor(private readonly opts: ApprovalGateOptions) {
    this.describe = opts.describe ?? describeApproval;
  }

  get approvedAll(): boolean {
    return this._approvedAll;
  }

  /** Whether anything is currently awaiting a decision. */
  get hasPending(): boolean {
    return this.pending !== undefined;
  }

  /** Await the user's decision for one tool call. Resolves true to allow. */
  async request(tool: string, args: unknown, signal?: AbortSignal): Promise<boolean> {
    if (this._approvedAll) return true;
    if (signal?.aborted) return false;

    const decision = await new Promise<Decision>((resolve) => {
      const timer = setTimeout(() => this.settle("deny"), this.opts.timeoutMs);
      this.pending = { resolve, timer };
      signal?.addEventListener("abort", () => this.settle("deny"), { once: true });
      Promise.resolve(this.opts.post(this.describe(tool, args))).catch((err) => {
        (this.opts.log ?? ((m: string) => console.warn(m)))(`approval post failed: ${String(err)}`);
        this.settle("deny");
      });
    });
    if (decision === "all") this._approvedAll = true;
    return decision !== "deny";
  }

  /** Resolve a pending request from a command. Returns true if one was pending. */
  resolve(kind: Decision): boolean {
    if (kind === "all") this._approvedAll = true;
    if (!this.pending) return false;
    this.settle(kind);
    return true;
  }

  /** End-of-turn: forget "approve all" and deny anything still pending. */
  resetTurn(): void {
    this._approvedAll = false;
    if (this.pending) this.settle("deny");
  }

  private settle(d: Decision): void {
    const p = this.pending;
    if (!p) return;
    this.pending = undefined;
    clearTimeout(p.timer);
    p.resolve(d);
  }
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run test/approval.test.ts && npx tsc --noEmit`
Expected: PASS（10 tests）

- [ ] **Step 5: 提交**

```bash
git add src/agent/approval.ts test/approval.test.ts
git commit -m "feat(approval): ApprovalGate state machine + safe-tool classification"
```

---

### Task 2: 配置（`APPROVAL_TIMEOUT_MS` / `APPROVAL_MODE`）

**Files:**
- Modify: `src/types.ts`、`src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces: `Config.approvalTimeoutMs: number`、`Config.approvalMode: ApprovalMode`

- [ ] **Step 1: 写失败测试**（追加到 `test/config.test.ts`）

```ts
it("parses APPROVAL_TIMEOUT_MS and APPROVAL_MODE", () => {
  const cfg = loadConfig({
    ANYTYPE_API_BASE_URL: "http://x", ANYTYPE_API_KEY: "k",
    APPROVAL_TIMEOUT_MS: "60000", APPROVAL_MODE: "ask",
  } as NodeJS.ProcessEnv);
  expect(cfg.approvalTimeoutMs).toBe(60000);
  expect(cfg.approvalMode).toBe("ask");
});
it("approval defaults: 300000 and auto; bad mode falls back to auto", () => {
  const cfg = loadConfig({ ANYTYPE_API_BASE_URL: "http://x", ANYTYPE_API_KEY: "k" } as NodeJS.ProcessEnv);
  expect(cfg.approvalTimeoutMs).toBe(300000);
  expect(cfg.approvalMode).toBe("auto");
  const bad = loadConfig({ ANYTYPE_API_BASE_URL: "http://x", ANYTYPE_API_KEY: "k", APPROVAL_MODE: "nope" } as NodeJS.ProcessEnv);
  expect(bad.approvalMode).toBe("auto");
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL（`cfg.approvalMode` undefined）

- [ ] **Step 3: 实现**

`src/types.ts`：`Config` 里加

```ts
  /** Pending-approval timeout in ms (env APPROVAL_TIMEOUT_MS). Default 300000; timeout = deny. */
  approvalTimeoutMs: number;
  /** Default approval mode for new (non-console) sessions (env APPROVAL_MODE). Default "auto". */
  approvalMode: ApprovalMode;
```

并在文件顶部加 `import type { ApprovalMode } from "./agent/approval.js";`。

`src/config.ts`：返回对象里加

```ts
    approvalTimeoutMs: posInt(env, "APPROVAL_TIMEOUT_MS", 300000),
    approvalMode: ((): ApprovalMode => {
      const v = (env.APPROVAL_MODE ?? "").trim().toLowerCase();
      return v === "ask" || v === "readonly" || v === "auto" ? v : "auto";
    })(),
```

并在 `src/config.ts` 顶部加 `import type { ApprovalMode } from "./agent/approval.js";`。

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run test/config.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/types.ts src/config.ts test/config.test.ts
git commit -m "feat(approval): APPROVAL_TIMEOUT_MS / APPROVAL_MODE config"
```

---

### Task 3: `effectiveToolNames` 三态 + 顶层闸门扩展（pi-session）

**Files:**
- Modify: `src/agent/pi-session.ts`
- Test: `test/pi-session.test.ts`

**Interfaces:**
- Consumes: `ApprovalMode`, `SAFE_TOOLS`, `needsApproval`, `ApprovalGate`（Task 1）
- Produces:
  - `effectiveToolNames(o: { isConsole: boolean; mode: ApprovalMode; allToolNames: string[] }): string[]`
  - `PiClientOptions.approvalMode?: ApprovalMode`、`PiClientOptions.approvalGate?: ApprovalGate`
  - `ManagedClient`（return 对象）加 `setApprovalMode(m): ApprovalMode`、`getApprovalMode(): ApprovalMode`、`approvePending(kind): boolean`

- [ ] **Step 1: 写失败测试**（替换/追加到 `test/pi-session.test.ts` 的 `effectiveToolNames` 块）

```ts
import { effectiveToolNames, CONSOLE_TOOLS } from "../src/agent/pi-session.js";

describe("effectiveToolNames (3 modes)", () => {
  const all = ["read", "bash", "anytype_create_note", "subagent", "agent"];
  it("auto: all tools", () => {
    expect(effectiveToolNames({ isConsole: false, mode: "auto", allToolNames: all })).toEqual(all);
  });
  it("ask: all tools (the gate blocks, not the tool set)", () => {
    expect(effectiveToolNames({ isConsole: false, mode: "ask", allToolNames: all })).toEqual(all);
  });
  it("readonly: safe tools + subagents, no writers", () => {
    const names = effectiveToolNames({ isConsole: false, mode: "readonly", allToolNames: all });
    expect(names).toContain("read");
    expect(names).toContain("subagent");
    expect(names).toContain("agent");
    expect(names).not.toContain("bash");
    expect(names).not.toContain("anytype_create_note");
  });
  it("console stays read-only regardless of mode", () => {
    expect(effectiveToolNames({ isConsole: true, mode: "auto", allToolNames: all })).toEqual([...CONSOLE_TOOLS]);
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run test/pi-session.test.ts`
Expected: FAIL（`mode` 字段不存在 / 类型不符）

- [ ] **Step 3: 实现**

3a. 顶部导入：

```ts
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import os from "node:os";
import { ApprovalGate, SAFE_TOOLS, needsApproval, type ApprovalMode } from "./approval.js";
```

> 若 `DefaultResourceLoader`/`ExtensionAPI` 未从包根导出，改用深路径
> `@earendil-works/pi-coding-agent/dist/core/resource-loader.js` 与
> `.../dist/core/extensions/types.js`（实现时用 `node -e "console.log(Object.keys(require('@earendil-works/pi-coding-agent')))"` 确认一次）。

3b. `READONLY_TOOLS` 现被 `SAFE_TOOLS` 取代：把 `effectiveToolNames` 改为三态（`READONLY_TOOLS` 的导出**保留**为 `SAFE_TOOLS` 的别名，避免破坏其它引用）：

```ts
/** @deprecated use SAFE_TOOLS. Kept as an alias for backwards compatibility. */
export const READONLY_TOOLS: readonly string[] = [...SAFE_TOOLS];

/** Effective tool names for a session.
 *  - console → always read-only (CONSOLE_TOOLS)
 *  - auto / ask → all tools (ask blocks via the gate, not the tool set)
 *  - readonly → safe tools + subagents (children inherit safe-only)
 */
export function effectiveToolNames(o: {
  isConsole: boolean;
  mode: ApprovalMode;
  allToolNames: string[];
}): string[] {
  if (o.isConsole) return [...CONSOLE_TOOLS];
  if (o.mode === "readonly") return [...SAFE_TOOLS, "subagent", "agent"];
  return [...o.allToolNames];
}
```

3c. `PiClientOptions` 加：

```ts
  /** Initial approval mode for this session. Default "auto". */
  approvalMode?: ApprovalMode;
  /** Approval gate shared with the tool-call hook (ask mode). */
  approvalGate?: ApprovalGate;
```

3d. 把 `let autoTools = true` 段替换为：

```ts
  // Approval mode drives the tool set (readonly) and the gate (ask).
  let approvalMode: ApprovalMode = opts.approvalMode ?? "auto";
  const applyTools = (): void => {
    session.setActiveToolsByName(
      effectiveToolNames({
        isConsole: opts.isConsole === true,
        mode: approvalMode,
        allToolNames: session.getAllTools().map((t) => t.name),
      }),
    );
  };
  applyTools();
```

3e. 在 `createAgentSession`（顶层，line ~290）的调用里加 `resourceLoader` 与闸门扩展：

```ts
  const approvalExtension = (pi: ExtensionAPI): void => {
    pi.on("tool_call", async (event, ctx) => {
      if (approvalMode !== "ask") return;              // auto/readonly → no gate
      const tool = event.toolName;
      if (!needsApproval(tool) && tool !== "subagent" && tool !== "agent") return; // safe → allow
      if (tool === "subagent" || tool === "agent") {
        return { block: true, reason: "ask 模式不支持子代理（会绕过批准）。用 /yolo auto，或直接在会话里做。" };
      }
      if (!opts.approvalGate) return;                  // no gate wired → allow
      const ok = await opts.approvalGate.request(tool, event.input, ctx.signal);
      return ok ? undefined : { block: true, reason: "用户未批准该操作。" };
    });
  };
```

并在顶层 `createAgentSession({ ... })` 里加：

```ts
    resourceLoader: new DefaultResourceLoader({
      cwd: opts.cwd,
      agentDir: opts.agentDir ?? path.join(os.homedir(), ".pi", "agent"),
      extensionFactories: [approvalExtension],
    }),
```

3f. `createChildAgent`：会话建好后，若当前模式为 `readonly` 则把子会话工具集设为 `SAFE_TOOLS`（子会话本身无 subagent/agent）：

```ts
    if (approvalMode === "readonly") {
      child.setActiveToolsByName([...SAFE_TOOLS]);
    }
```

3g. 返回对象的 `setAutoTools`/`isAutoTools` 替换为模式方法（**保留** `setAutoTools` 供 `/yolo on|off` 别名）：

```ts
    setApprovalMode(m: ApprovalMode): ApprovalMode {
      if (opts.isConsole) return approvalMode; // console is always read-only
      approvalMode = m;
      applyTools();
      return approvalMode;
    },
    getApprovalMode(): ApprovalMode {
      return opts.isConsole ? "readonly" : approvalMode;
    },
    approvePending(kind: "approve" | "all" | "deny"): boolean {
      return opts.approvalGate?.resolve(kind) ?? false;
    },
    setAutoTools(enabled: boolean): string {
      if (opts.isConsole) return "控制台始终只读（/yolo 在此无效）";
      approvalMode = enabled ? "auto" : "ask";
      applyTools();
      return enabled ? "YOLO 自动模式：开" : "已切到 ask 模式（每次写操作都需批准）";
    },
    isAutoTools(): boolean {
      return approvalMode === "auto";
    },
```

3h. `prompt()` 里在开头调用 `opts.approvalGate?.resetTurn();`（每回合清"全批准"）。

3i. `applyTools()` 首次调用后、`setApprovalMode` 修改后都要重建工具集——已由 3d/3g 覆盖。

- [ ] **Step 4: 运行，确认通过 + 全量**

Run: `npx vitest run test/pi-session.test.ts && npx tsc --noEmit`
Expected: PASS；若其它测试引用了旧的 `effectiveToolNames({autoTools})`，一并改成 `mode`。

- [ ] **Step 5: 提交**

```bash
git add src/agent/pi-session.ts test/pi-session.test.ts
git commit -m "feat(approval): three-mode tool set + tool_call gate extension"
```

---

### Task 4: SessionManager per-chat 模式 + approvePending

**Files:**
- Modify: `src/session/manager.ts`
- Test: `test/session-manager.test.ts`

**Interfaces:**
- Consumes: `ApprovalMode`（Task 1）
- Produces:
  - `ManagedClient` 加可选 `setApprovalMode?(m: ApprovalMode): ApprovalMode`、`getApprovalMode?(): ApprovalMode`、`approvePending?(kind: "approve"|"all"|"deny"): boolean`
  - `SessionManagerOptions.defaultApprovalMode?: ApprovalMode`
  - `SessionManager.getApprovalMode(chatId): ApprovalMode`、`setApprovalMode(chatId, m): ApprovalMode`、`approvePending(chatId, kind): boolean`

- [ ] **Step 1: 写失败测试**（追加到 `test/session-manager.test.ts`）

```ts
import type { ApprovalMode } from "../src/agent/approval.js";

it("remembers approval mode per chat and applies it to a live client", async () => {
  const setMode = vi.fn((m: ApprovalMode) => m);
  const approve = vi.fn(() => true);
  const createClient = vi.fn(async () => ({
    get busy() { return false; },
    async prompt() { return "ok"; },
    async close() {}, async abort() {},
    setApprovalMode: setMode, getApprovalMode: () => "auto" as ApprovalMode, approvePending: approve,
  }));
  const mgr = new SessionManager({ createClient, maxConcurrent: 3, idleMs: 100000, defaultApprovalMode: "ask" });
  expect(mgr.getApprovalMode("c1")).toBe("ask"); // default before a client exists
  await mgr.ensure("c1");
  expect(setMode).toHaveBeenCalledWith("ask");   // adopted at creation
  expect(mgr.setApprovalMode("c1", "readonly")).toBe("readonly");
  expect(setMode).toHaveBeenLastCalledWith("readonly");
  expect(mgr.approvePending("c1", "all")).toBe(true);
  expect(approve).toHaveBeenCalledWith("all");
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run test/session-manager.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

3a. `ManagedClient` 接口加：

```ts
  /** Set this chat's approval mode; returns the applied mode. */
  setApprovalMode?(mode: ApprovalMode): ApprovalMode;
  /** Current approval mode. */
  getApprovalMode?(): ApprovalMode;
  /** Resolve a pending approval from a command. Returns true if one was pending. */
  approvePending?(kind: "approve" | "all" | "deny"): boolean;
```

3b. `SessionManagerOptions` 加 `defaultApprovalMode?: ApprovalMode`；私有字段 `private approvalModes = new Map<string, ApprovalMode>();`。

3c. 仿 `getInterruptPolicy`/`setInterruptPolicy`（line 115-135）加：

```ts
  getApprovalMode(chatId: string): ApprovalMode {
    return (
      this.approvalModes.get(chatId) ??
      this.entries.get(chatId)?.client.getApprovalMode?.() ??
      this.opts.defaultApprovalMode ??
      "auto"
    );
  }

  setApprovalMode(chatId: string, mode: ApprovalMode): ApprovalMode {
    this.approvalModes.set(chatId, mode);
    const e = this.entries.get(chatId);
    if (e) e.client.setApprovalMode?.(mode);
    return e ? (e.client.getApprovalMode?.() ?? mode) : mode;
  }

  approvePending(chatId: string, kind: "approve" | "all" | "deny"): boolean {
    return this.entries.get(chatId)?.client.approvePending?.(kind) ?? false;
  }
```

3d. 在 `getOrCreate` 里、`client.setInterruptPolicy?.(...)`（line ~177）之后加：

```ts
    client.setApprovalMode?.(this.getApprovalMode(chatId));
```

- [ ] **Step 4: 运行，确认通过 + 全量**

Run: `npx vitest run test/session-manager.test.ts && npx tsc --noEmit && npx vitest run`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/session/manager.ts test/session-manager.test.ts
git commit -m "feat(approval): per-chat approval mode in SessionManager"
```

---

### Task 5: 命令 `/yolo` 三态 + `/approve` `/deny`

**Files:**
- Modify: `src/commands/handler.ts`
- Test: `test/commands-handler.test.ts`

**Interfaces:**
- Consumes: `ApprovalMode`（Task 1）
- Produces:
  - `CommandContext.getApprovalMode(): ApprovalMode`、`setApprovalMode(m: ApprovalMode): ApprovalMode`、`approvePending(kind: "approve"|"all"|"deny"): boolean`
  - `approvalLabel(m: ApprovalMode): string`

- [ ] **Step 1: 写失败测试**（追加到 `test/commands-handler.test.ts`；并给 `ctx()` 补上三个新方法）

在 `ctx()` 里加：

```ts
  let mode: ApprovalMode = "auto";
  const setApprovalMode = vi.fn((m: ApprovalMode) => { mode = m; return m; });
  const approvePending = vi.fn(() => true);
  const getApprovalMode = () => mode;
```

并把这三个塞进 `context`。

新增测试：

```ts
it("/yolo with no arg reports the approval mode", async () => {
  const { context } = ctx(fakeClient());
  const reply = await handleCommand("yolo", "", context);
  expect(reply).toContain("auto");
});
it("/yolo ask sets ask mode", async () => {
  const { context, setApprovalMode } = ctx(fakeClient()); // 让 ctx() 也返回 setApprovalMode
  const reply = await handleCommand("yolo", "ask", context);
  expect(setApprovalMode).toHaveBeenCalledWith("ask");
  expect(reply).toMatch(/ask|批准/);
});
it("/yolo on → auto, /yolo off → ask (aliases)", async () => {
  const { context, setApprovalMode } = ctx(fakeClient());
  await handleCommand("yolo", "on", context);
  expect(setApprovalMode).toHaveBeenLastCalledWith("auto");
  await handleCommand("yolo", "off", context);
  expect(setApprovalMode).toHaveBeenLastCalledWith("ask");
});
it("/yolo readonly sets readonly", async () => {
  const { context, setApprovalMode } = ctx(fakeClient());
  await handleCommand("yolo", "readonly", context);
  expect(setApprovalMode).toHaveBeenLastCalledWith("readonly");
});
it("/approve delegates to approvePending('approve')", async () => {
  const { context, approvePending } = ctx(fakeClient());
  const reply = await handleCommand("approve", "", context);
  expect(approvePending).toHaveBeenCalledWith("approve");
  expect(reply.length).toBeGreaterThan(0);
});
it("/approve all delegates with 'all'", async () => {
  const { context, approvePending } = ctx(fakeClient());
  await handleCommand("approve", "all", context);
  expect(approvePending).toHaveBeenCalledWith("all");
});
it("/deny delegates with 'deny'", async () => {
  const { context, approvePending } = ctx(fakeClient());
  await handleCommand("deny", "", context);
  expect(approvePending).toHaveBeenCalledWith("deny");
});
it("/approve with nothing pending says so", async () => {
  const { context } = ctx(fakeClient());
  // override approvePending to return false
  const c2 = { ...context, approvePending: vi.fn(() => false) };
  const reply = await handleCommand("approve", "", c2);
  expect(reply).toMatch(/没有|无/);
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run test/commands-handler.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

3a. `CommandContext` 加三方法与类型导入：

```ts
import type { ApprovalMode } from "../agent/approval.js";
// ...
  /** Current approval mode for this chat. */
  getApprovalMode(): ApprovalMode;
  /** Set the approval mode; returns the applied mode. */
  setApprovalMode(mode: ApprovalMode): ApprovalMode;
  /** Resolve a pending approval. Returns true if one was pending. */
  approvePending(kind: "approve" | "all" | "deny"): boolean;
```

3b. 加 label：

```ts
export function approvalLabel(m: ApprovalMode): string {
  return m === "auto" ? "auto（不问，直接执行）" : m === "ask" ? "ask（每次写操作需批准）" : "readonly（不能写）";
}
```

3c. 替换 `case "yolo"`：

```ts
    case "yolo": {
      if (!args) {
        return `审批模式：${approvalLabel(ctx.getApprovalMode())}`;
      }
      const arg = args.toLowerCase();
      let mode: ApprovalMode;
      if (arg === "auto" || arg === "on") mode = "auto";
      else if (arg === "ask" || arg === "off") mode = "ask";
      else if (arg === "readonly" || arg === "ro") mode = "readonly";
      else return `用法：/yolo [auto|ask|readonly]（当前：${approvalLabel(ctx.getApprovalMode())}）`;
      const applied = ctx.setApprovalMode(mode);
      return `审批模式已设为：${approvalLabel(applied)}`;
    }
```

3d. 新增（放在 `case "yolo"` 之后）：

```ts
    case "approve": {
      const kind = args.trim().toLowerCase() === "all" ? "all" : "approve";
      const had = ctx.approvePending(kind);
      return had
        ? kind === "all" ? "已批准本次及本回合后续操作。" : "已批准本次操作。"
        : "当前没有待批准的操作。";
    }

    case "deny": {
      const had = ctx.approvePending("deny");
      return had ? "已拒绝该操作。" : "当前没有待批准的操作。";
    }
```

3e. `HELP_TEXT`：把 `/yolo` 行改为

```
  "/yolo [auto|ask|readonly] — 审批模式：auto=不问，ask=写操作需批准（/yolo off），readonly=不能写（/yolo readonly）",
  "/approve [all] — 批准待批准的操作（all=本回合剩余全放行）",
  "/deny — 拒绝待批准的操作",
```

- [ ] **Step 4: 运行，确认通过 + 全量**

Run: `npx vitest run test/commands-handler.test.ts && npx tsc --noEmit && npx vitest run`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/commands/handler.ts test/commands-handler.test.ts
git commit -m "feat(approval): /yolo auto|ask|readonly + /approve + /deny commands"
```

---

### Task 6: 接线（main.ts）——闸门 post + 命令 ctx + 初值

**Files:**
- Modify: `src/main.ts`
- Test: 无单测（编译 + 实机）；`npx tsc --noEmit && npm run build && npx vitest run`

**Interfaces:**
- Consumes: Task 1-5 的全部
- Produces: 运行时闭环

- [ ] **Step 1: 实现**

1a. 导入：

```ts
import { ApprovalGate } from "./agent/approval.js";
import type { ApprovalMode } from "./agent/approval.js";
```

1b. 建 gate（放在 `sink` 之后，需要一个 `post`）。**每个聊天一个 gate**：最简单是在 main 里维护 `Map<chatId, ApprovalGate>`，按需创建；`post` 用 `api.sendMessage`：

```ts
  // One approval gate per chat; its `post` writes the prompt into that chat.
  const gates = new Map<string, ApprovalGate>();
  const gateFor = (target: ChatTarget): ApprovalGate => {
    let g = gates.get(target.chatId);
    if (!g) {
      g = new ApprovalGate({
        timeoutMs: cfg.approvalTimeoutMs,
        post: (text) => api.sendMessage(target.spaceId, target.chatId, text, `approval-${target.chatId}-${Date.now()}`),
      });
      gates.set(target.chatId, g);
    }
    return g;
  };
```

1c. `createClient` 里，给 `createPiClient` 传 gate 与初值。gate 需要目标（space+chat），此时已知 `spaceId`/`chatId`：

```ts
        approvalGate: gateFor({ spaceId, chatId }),
        approvalMode: sessions.getApprovalMode(chatId),
```

1d. `CommandContext` 对象里加：

```ts
            getApprovalMode: () => sessions.getApprovalMode(e.chatId),
            setApprovalMode: (m) => sessions.setApprovalMode(e.chatId, m),
            approvePending: (kind) => sessions.approvePending(e.chatId, kind),
```

1e. `SessionManager` 构造里加 `defaultApprovalMode: cfg.approvalMode,`。

> 注意：`/yolo`、`/approve`、`/deny` 都是**命令**，不经 agent、不排队——所以即使某回合正卡在等批准也能立刻响应。

- [ ] **Step 2: 编译 + 全量**

Run: `npx tsc --noEmit && npm run build && npx vitest run`
Expected: 全绿

- [ ] **Step 3: 提交**

```bash
git add src/main.ts
git commit -m "feat(approval): wire the gate, commands and mode defaults (main)"
```

---

### Task 7: 文档 + 部署 + 实机验证

**Files:**
- Modify: `docs/RUNBOOK.md`、`CLAUDE.md`、`README.zh-CN.md`

- [ ] **Step 1: 文档**

- `RUNBOOK.md`：更新 `/yolo` 行与新增指令行；加一节「审批模式（auto/ask/readonly）」说明：默认 auto；`/yolo ask` 后写操作前会问，回 `/approve`、`/approve all`、`/deny`；超时 5 分钟=拒；`ask` 下子代理被拒（会提示）；`readonly`=不能写（子代理也只读）；`/yolo off` 现在=ask（**旧行为"只读"改用 `/yolo readonly`**）。`APPROVAL_TIMEOUT_MS`/`APPROVAL_MODE` 进配置表。
- `CLAUDE.md`：Key facts 加一条——审批模式 per-chat（`ApprovalMode`），`ask` 由 pi 扩展 `on("tool_call")` 闸门强制（block），控制台恒 readonly，`effectiveToolNames` 三态。
- `README.zh-CN.md`：更新 `/yolo` 相关 bullet（三态）。

- [ ] **Step 2: 构建 + 部署**

```bash
npm run build && docker build -t anytype-ai-bot:latest .
cd /home/landspace/anytype && docker compose -f docker-compose.yml -f /home/landspace/anytype-ai-bot/docker-compose.bot.yml up -d --force-recreate --no-deps ai-bot
```

- [ ] **Step 3: 实机验证**

在一个普通空间（如控制台，或新建 2 人空间）：
1. 默认 `auto`：让它建个页面 → 直接建，不提问（行为不变）。
2. `/yolo ask`：再让它建页面 → 聊天里出现「⚠️ 想执行 anytype_create_note(...)」；`/approve` → 建成功。
3. 再让它连做两个写操作 → 各自提问；在第一个提问时回 `/approve all` → 后续不再问。
4. `/yolo ask` 下让它 `subagent` → 被拒并提示。
5. `/yolo readonly` → 让它写 → 无写工具（或提示）。
6. 控制台恒只读：`/yolo` 在控制台仍无效。
`docker logs --tail 40 anytype-ai-bot-1`

- [ ] **Step 4: 提交**

```bash
git add docs/RUNBOOK.md CLAUDE.md README.zh-CN.md
git commit -m "docs: approval flow (auto/ask/readonly, /approve, /deny)"
```

---

## 自检记录

- **Spec 覆盖**：§2 三态 → T3（effectiveToolNames）+ T5（/yolo）；§3 SAFE_TOOLS/needsApproval → T1；§4 闸门/提问/超时/`all` → T1（gate）+ T3（扩展）+ T6（post 接线）；§5 打断 → T1（abort）+ T3（ctx.signal）+ T3h（resetTurn）；§6 组件 → 各 Task Files；§7 配置 → T2；§8 测试 → 各 Task 测试步骤 + T7 实机。未覆盖项：无。
- **类型一致**：`ApprovalMode`、`ApprovalGate`、`SAFE_TOOLS`、`needsApproval`、`effectiveToolNames({isConsole,mode,allToolNames})`、`setApprovalMode/getApprovalMode/approvePending`（Client 与 SessionManager 两名一致）、`approvePending(kind:"approve"|"all"|"deny")` 全链一致。
- **风险**：T3 的 `DefaultResourceLoader`/`ExtensionAPI` 导出路径需现场确认一次（已给 fallback）；T3 改动会触及既有 `effectiveToolNames({autoTools})` 调用点（仅 pi-session 内部 + 测试），要一并改 `mode`。
