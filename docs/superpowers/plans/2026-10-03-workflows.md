# 工作流（引擎编排）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 引擎按序执行 `docker/workflows/<name>/workflow.yaml` 里的确定性步骤（shell/anytype/http/**agent**），记录每步状态/日志、失败可重试、可从断点续跑；仅 `agent` 步骤调模型，且绑目标空间。

**Architecture:** 五块：`schema.ts`（解析+变量插值+`if` 求值）、`store.ts`（每 run 一目录的状态/日志/产出）、`steps.ts`（4 个执行器，依赖注入以便单测）、`runner.ts`（顺序执行 / `if` / `retry` / `resume` / 事件投递）、`registry.ts`（发现 `docker/workflows/*`）。`/run` 命令与 cron 触发接进现有 main。安全性沿用既有批准闸门（anytype 写步骤/agent 步骤按会话模式过闸门）。

**Tech Stack:** TypeScript (NodeNext, strict)、vitest、`yaml`（新增依赖，ISC）、内嵌 pi SDK（`agent` 步骤复用 `createChildAgent`）。

## Global Constraints

- 工作流定义：`docker/workflows/<name>/workflow.yaml`（+ 可选 `README.md`）；启动时 `ensureWorkflowsConfig` 拷进 pi agentDir 的 `workflows/`（**只补缺不覆盖**，照 `ensureSkillsConfig`）。
- 步骤 `uses ∈ {shell, anytype, http, agent}`；**有序执行**；`if:`（简单比较/真值，非表达式引擎）；`retry: N`。
- 变量插值 `{{ steps.<id>.output }}`、`{{ on.cron }}`/`{{ on.notify }}`、`{{ env.X }}`——**字面替换**，不求值。
- run 目录 `/workspace/workflow-runs/<id>/`（`state.json` + `log.ndjson` + `steps/<id>.out`）；失败**中止**；`--resume` 从**第一个非 done 步骤**续。
- 触发 v1：手动 `/run` + cron（复用 `pollDueWatches` tick）。
- 结果发**触发聊天**；**工作流状态对话**聚合每步事件（`WORKFLOW_STATUS_CHAT` 或自动建）。
- `agent` 步骤：复用 `createChildAgent({spaceId,cwd,readOnly:false})`（绑目标空间）；未知空间**报错**（勿回退）。
- 提交信息英文，风格 `feat:/fix:/docs:/test:`。实机验证用 `docker build` + 重建 bot。

## 文件结构

| 文件 | 责任 |
|---|---|
| `src/workflow/schema.ts`（新） | 类型 + `parseWorkflow` + `render` + `evalIf` |
| `src/workflow/store.ts`（新） | `WorkflowRunStore`（run 目录读写）|
| `src/workflow/steps.ts`（新） | 4 个步骤执行器（注入 deps）|
| `src/workflow/runner.ts`（新） | `runWorkflow`（顺序/if/retry/resume/事件）|
| `src/workflow/registry.ts`（新） | 发现/加载 `docker/workflows/*` |
| `src/agent/pi-session.ts`（改） | `ensureWorkflowsConfig`；`runAgentInSpace` |
| `src/commands/handler.ts`（改） | `/run`、`/runs`；`CommandContext` 扩展 |
| `src/main.ts`（改） | 接线 `/run`；状态对话；cron 触发 |
| `src/config.ts` / `src/types.ts`（改） | `workflowStatusChat?`、`workflowDir`、`workflowRunDir` |

---

### Task 1: `schema.ts`（定义解析 + 插值 + if）

**Files:**
- Modify: `package.json`（加 `yaml`）
- Create: `src/workflow/schema.ts`
- Test: `test/workflow-schema.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type StepUse = "shell" | "anytype" | "http" | "agent";
  export interface Step { id: string; uses: StepUse; with: Record<string, unknown>; if?: string; retry?: number }
  export interface WorkflowDef { name: string; description?: string; on?: { cron?: string; notify?: string }; steps: Step[] }
  export function parseWorkflow(yamlText: string): WorkflowDef;      // throws on invalid
  export function render(tpl: string, scope: Record<string, unknown>): string;
  export function evalIf(rendered: string): boolean;
  ```

- [ ] **Step 1: 安装依赖**

Run: `npm i yaml`
Expected: `yaml` 出现在 `dependencies`；`node -e "require('yaml')"` 不报错。

- [ ] **Step 2: 写失败测试**

```ts
// test/workflow-schema.test.ts
import { describe, it, expect } from "vitest";
import { parseWorkflow, render, evalIf } from "../src/workflow/schema.js";

const GOOD = `
name: demo
description: a demo
on:
  cron: "0 9 * * *"
  notify: chat123
steps:
  - id: read
    uses: anytype
    with: { op: read_object, id: abc }
  - id: judge
    uses: agent
    with: { space: pqdthe, prompt: "yes or no?" }
    retry: 2
  - id: notify
    if: "{{ steps.judge.output }} == 'yes'"
    uses: anytype
    with: { op: send_message, text: "{{ steps.judge.output }}" }
`;

describe("parseWorkflow", () => {
  it("parses name/on/steps with ids, uses, with, if, retry", () => {
    const d = parseWorkflow(GOOD);
    expect(d.name).toBe("demo");
    expect(d.on).toEqual({ cron: "0 9 * * *", notify: "chat123" });
    expect(d.steps.map((s) => s.id)).toEqual(["read", "judge", "notify"]);
    expect(d.steps[1].uses).toBe("agent");
    expect(d.steps[1].retry).toBe(2);
    expect(d.steps[2].if).toBe("{{ steps.judge.output }} == 'yes'");
  });
  it("rejects a missing name", () => {
    expect(() => parseWorkflow("steps: []")).toThrow(/name/);
  });
  it("rejects a step with no id or a bad uses", () => {
    expect(() => parseWorkflow("name: x\nsteps:\n  - uses: shell\n    with: { run: ls }")).toThrow(/id/);
    expect(() => parseWorkflow("name: x\nsteps:\n  - id: a\n    uses: nope\n    with: {}")).toThrow(/uses/);
  });
  it("rejects duplicate step ids", () => {
    expect(() => parseWorkflow("name: x\nsteps:\n  - { id: a, uses: shell, with: { run: ls } }\n  - { id: a, uses: shell, with: { run: pwd } }")).toThrow(/duplicate/i);
  });
});

describe("render", () => {
  it("substitutes dotted paths, stringifying values", () => {
    expect(render(">{{ steps.judge.output }}<", { steps: { judge: { output: "yes" } } })).toBe(">yes<");
    expect(render("{{ n }}", { n: 42 })).toBe("42");
  });
  it("unknown path → empty string", () => {
    expect(render("[{{ steps.x.output }}]", { steps: {} })).toBe("[]");
  });
  it("leaves non-template text untouched", () => {
    expect(render("hello", {})).toBe("hello");
  });
});

describe("evalIf", () => {
  it("compares with == and != after stripping quotes", () => {
    expect(evalIf("yes == 'yes'")).toBe(true);
    expect(evalIf("no == 'yes'")).toBe(false);
    expect(evalIf("yes != 'no'")).toBe(true);
  });
  it("bare value is truthy unless empty/false/0/no", () => {
    expect(evalIf("hello")).toBe(true);
    expect(evalIf("")).toBe(false);
    expect(evalIf("false")).toBe(false);
    expect(evalIf("0")).toBe(false);
    expect(evalIf("no")).toBe(false);
  });
});
```

- [ ] **Step 3: 运行，确认失败**

Run: `npx vitest run test/workflow-schema.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 实现**

```ts
// src/workflow/schema.ts
import { parse as parseYaml } from "yaml";

export type StepUse = "shell" | "anytype" | "http" | "agent";
const USES = new Set<StepUse>(["shell", "anytype", "http", "agent"]);

export interface Step {
  id: string;
  uses: StepUse;
  with: Record<string, unknown>;
  /** Simple guard, e.g. "{{ steps.judge.output }} == 'yes'". Rendered then eval'd. */
  if?: string;
  /** Retry attempts on failure (in addition to the first try). Default 0. */
  retry?: number;
}

export interface WorkflowDef {
  name: string;
  description?: string;
  on?: { cron?: string; notify?: string };
  steps: Step[];
}

/** Parse + validate a workflow.yaml. Throws with a clear message on anything invalid. */
export function parseWorkflow(yamlText: string): WorkflowDef {
  const raw = parseYaml(yamlText) as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object") throw new Error("workflow: empty or not an object");
  const name = raw.name;
  if (typeof name !== "string" || name.trim() === "") throw new Error("workflow: `name` is required");
  const stepsRaw = raw.steps;
  if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) throw new Error("workflow: `steps` must be a non-empty array");
  const seen = new Set<string>();
  const steps: Step[] = stepsRaw.map((s, i) => {
    if (!s || typeof s !== "object") throw new Error(`workflow: step ${i} is not an object`);
    const st = s as Record<string, unknown>;
    const id = st.id;
    if (typeof id !== "string" || id.trim() === "") throw new Error(`workflow: step ${i} needs an \`id\``);
    if (seen.has(id)) throw new Error(`workflow: duplicate step id \`${id}\``);
    seen.add(id);
    const uses = st.uses;
    if (typeof uses !== "string" || !USES.has(uses as StepUse)) {
      throw new Error(`workflow: step \`${id}\` has invalid \`uses\` (want shell|anytype|http|agent)`);
    }
    const withRaw = st.with;
    const withObj = withRaw && typeof withRaw === "object" ? (withRaw as Record<string, unknown>) : {};
    const step: Step = { id, uses: uses as StepUse, with: withObj };
    if (typeof st.if === "string") step.if = st.if;
    if (typeof st.retry === "number" && st.retry >= 0) step.retry = st.retry;
    return step;
  });
  const def: WorkflowDef = { name, steps };
  if (typeof raw.description === "string") def.description = raw.description;
  const onRaw = raw.on;
  if (onRaw && typeof onRaw === "object") {
    const on = onRaw as Record<string, unknown>;
    const onObj: { cron?: string; notify?: string } = {};
    if (typeof on.cron === "string") onObj.cron = on.cron;
    if (typeof on.notify === "string") onObj.notify = on.notify;
    if (Object.keys(onObj).length > 0) def.on = onObj;
  }
  return def;
}

/** Look up a dotted path in a nested object; undefined when missing. */
function lookup(scope: Record<string, unknown>, path: string): unknown {
  let cur: unknown = scope;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Replace every `{{ dotted.path }}` with the scope value (String(...)); unknown → "". */
export function render(tpl: string, scope: Record<string, unknown>): string {
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path: string) => {
    const v = lookup(scope, path);
    return v === undefined || v === null ? "" : String(v);
  });
}

const FALSY = new Set(["", "false", "0", "no"]);

/**
 * Evaluate a rendered guard. Supports `<lhs> == <rhs>` / `<lhs> != <rhs>`
 * (string compare, surrounding quotes stripped); otherwise truthiness of the
 * whole string (empty / "false" / "0" / "no" → false).
 */
export function evalIf(rendered: string): boolean {
  const eq = rendered.match(/^(.*?)\s*(==|!=)\s*(.*)$/);
  if (eq) {
    const strip = (s: string): string => s.trim().replace(/^['"]|['"]$/g, "");
    const a = strip(eq[1]);
    const b = strip(eq[3]);
    return eq[2] === "==" ? a === b : a !== b;
  }
  return !FALSY.has(rendered.trim().toLowerCase());
}
```

- [ ] **Step 5: 运行，确认通过**

Run: `npx vitest run test/workflow-schema.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add package.json package-lock.json src/workflow/schema.ts test/workflow-schema.test.ts
git commit -m "feat(workflow): definition schema (parse + render + if)"
```

---

### Task 2: `store.ts`（run 状态/日志/产出）

**Files:**
- Create: `src/workflow/store.ts`
- Test: `test/workflow-store.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";
  export interface StepState { id: string; uses: string; status: StepStatus; output?: string; error?: string; startedAt?: string; endedAt?: string }
  export type RunStatus = "running" | "done" | "failed";
  export interface RunState { id: string; name: string; chatId: string; spaceId: string; trigger: string; status: RunStatus; createdAt: string; updatedAt: string; steps: StepState[] }
  export class WorkflowRunStore {
    constructor(root: string);                 // e.g. /workspace/workflow-runs
    create(state: RunState): void;             // mkdir + write state.json
    load(id: string): RunState | null;
    save(state: RunState): void;               // rewrite state.json (+ updatedAt)
    log(id: string, line: string): void;       // append to log.ndjson
    writeStepOutput(id: string, stepId: string, text: string): string; // steps/<stepId>.out, returns path
    dir(id: string): string;
  }
  export function newRunId(now?: Date): string;  // e.g. 20261003-090000-<4hex>
  ```

- [ ] **Step 1: 写失败测试**

```ts
// test/workflow-store.test.ts
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkflowRunStore, newRunId, type RunState } from "../src/workflow/store.js";

function tmpRoot(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "wfrun-")); }
function mkState(id: string): RunState {
  return { id, name: "demo", chatId: "c", spaceId: "s", trigger: "manual", status: "running",
    createdAt: "t0", updatedAt: "t0", steps: [{ id: "a", uses: "shell", status: "pending" }] };
}

describe("WorkflowRunStore", () => {
  it("creates, saves and loads run state", () => {
    const store = new WorkflowRunStore(tmpRoot());
    const st = mkState("r1");
    store.create(st);
    expect(store.load("r1")?.name).toBe("demo");
    st.status = "done"; st.steps[0].status = "done"; st.steps[0].output = "hi";
    store.save(st);
    const back = store.load("r1")!;
    expect(back.status).toBe("done");
    expect(back.steps[0].output).toBe("hi");
  });
  it("appends log lines and writes step outputs to files", () => {
    const root = tmpRoot();
    const store = new WorkflowRunStore(root);
    store.create(mkState("r2"));
    store.log("r2", "hello");
    store.log("r2", "world");
    const log = fs.readFileSync(path.join(store.dir("r2"), "log.ndjson"), "utf-8").trim().split("\n");
    expect(log).toEqual(["hello", "world"]);
    const p = store.writeStepOutput("r2", "a", "big output");
    expect(fs.readFileSync(p, "utf-8")).toBe("big output");
  });
  it("load returns null for a missing run", () => {
    expect(new WorkflowRunStore(tmpRoot()).load("nope")).toBeNull();
  });
});

describe("newRunId", () => {
  it("is filesystem-safe and unique-ish", () => {
    const id = newRunId(new Date("2026-10-03T09:00:00Z"));
    expect(id).toMatch(/^[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/);
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run test/workflow-store.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// src/workflow/store.ts
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";
export interface StepState {
  id: string;
  uses: string;
  status: StepStatus;
  output?: string;
  error?: string;
  startedAt?: string;
  endedAt?: string;
}
export type RunStatus = "running" | "done" | "failed";
export interface RunState {
  id: string;
  name: string;
  chatId: string;
  spaceId: string;
  trigger: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  steps: StepState[];
}

/** A fresh, filesystem-safe run id: YYYYMMDD-HHMMSS-<4hex>. */
export function newRunId(now: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${stamp}-${crypto.randomBytes(2).toString("hex")}`;
}

/** Persistence for workflow runs: one directory per run under `root`. */
export class WorkflowRunStore {
  constructor(private readonly root: string) {}

  dir(id: string): string {
    return path.join(this.root, id);
  }

  create(state: RunState): void {
    fs.mkdirSync(this.dir(state.id), { recursive: true });
    this.save(state);
  }

  load(id: string): RunState | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir(id), "state.json"), "utf-8")) as RunState;
    } catch {
      return null;
    }
  }

  save(state: RunState): void {
    state.updatedAt = new Date().toISOString();
    const d = this.dir(state.id);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "state.json"), JSON.stringify(state, null, 2), "utf-8");
  }

  log(id: string, line: string): void {
    const d = this.dir(id);
    fs.mkdirSync(d, { recursive: true });
    fs.appendFileSync(path.join(d, "log.ndjson"), line + "\n", "utf-8");
  }

  writeStepOutput(id: string, stepId: string, text: string): string {
    const d = path.join(this.dir(id), "steps");
    fs.mkdirSync(d, { recursive: true });
    const p = path.join(d, `${stepId}.out`);
    fs.writeFileSync(p, text, "utf-8");
    return p;
  }
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run test/workflow-store.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/workflow/store.ts test/workflow-store.test.ts
git commit -m "feat(workflow): run store (state/log/step-output under one dir)"
```

---

### Task 3: `steps.ts`（4 个执行器）

**Files:**
- Create: `src/workflow/steps.ts`
- Test: `test/workflow-steps.test.ts`

**Interfaces:**
- Consumes: `Step`（Task 1）
- Produces:
  ```ts
  export interface StepContext {
    api: AnytypeClient;
    spaceId: string;                 // default space for the `anytype` step
    workspaceDir: string;            // cwd for `shell`
    runAgent: (space: string, prompt: string, tools?: string[]) => Promise<string>;
    fetchFn?: typeof fetch;
    exec?: (cmd: string, opts: { cwd?: string; timeoutMs?: number }) => Promise<{ stdout: string; stderr: string }>;
    log?: (line: string) => void;
  }
  export async function runStep(step: Step, args: Record<string, unknown>, ctx: StepContext): Promise<string>;
  ```
  其中 `args` 是**已渲染**的 `step.with`（变量已替换）。

- [ ] **Step 1: 写失败测试**（注入 fake，不触网、不真跑 shell）

```ts
// test/workflow-steps.test.ts
import { describe, it, expect, vi } from "vitest";
import { runStep, type StepContext } from "../src/workflow/steps.js";
import type { Step } from "../src/workflow/schema.js";

function ctx(over: Partial<StepContext> = {}): StepContext {
  return {
    api: {
      getObjectRaw: vi.fn(async () => ({ properties: { name: "卷子" } })),
      createObject: vi.fn(async () => ({ id: "new123" })),
      sendMessage: vi.fn(async () => {}),
      search: vi.fn(async () => [{ id: "o1", name: "考试", type: "page" }]),
    } as unknown as StepContext["api"],
    spaceId: "sp1", workspaceDir: "/tmp",
    runAgent: vi.fn(async () => "yes"),
    exec: vi.fn(async () => ({ stdout: "hi\n", stderr: "" })),
    fetchFn: vi.fn(async () => new Response("body text")) as unknown as typeof fetch,
    ...over,
  };
}
const step = (uses: Step["uses"], w: Record<string, unknown>): Step => ({ id: "s", uses, with: w });

describe("runStep", () => {
  it("shell: runs the command and returns stdout", async () => {
    const c = ctx();
    expect(await runStep(step("shell", { run: "echo hi" }), { run: "echo hi" }, c)).toBe("hi\n");
    expect(c.exec).toHaveBeenCalledWith("echo hi", expect.objectContaining({ cwd: "/tmp" }));
  });
  it("anytype read_object: returns the rendered object text", async () => {
    const out = await runStep(step("anytype", { op: "read_object", id: "o1" }), { op: "read_object", id: "o1" }, ctx());
    expect(out).toContain("卷子");
  });
  it("anytype create_note: creates and returns the new id", async () => {
    const out = await runStep(step("anytype", { op: "create_note", name: "x", markdown: "b" }), { op: "create_note", name: "x", markdown: "b" }, ctx());
    expect(out).toContain("new123");
  });
  it("anytype send_message: needs chat+text", async () => {
    const c = ctx();
    await runStep(step("anytype", { op: "send_message", chat: "c", text: "hi" }), { op: "send_message", chat: "c", text: "hi" }, c);
    expect(c.api.sendMessage).toHaveBeenCalled();
  });
  it("agent: delegates to runAgent(space, prompt)", async () => {
    const c = ctx();
    const out = await runStep(step("agent", { space: "sp", prompt: "yes?" }), { space: "sp", prompt: "yes?" }, c);
    expect(out).toBe("yes");
    expect(c.runAgent).toHaveBeenCalledWith("sp", "yes?", undefined);
  });
  it("http: fetches the url and returns the body", async () => {
    const out = await runStep(step("http", { url: "http://x" }), { url: "http://x" }, ctx());
    expect(out).toBe("body text");
  });
  it("anytype unknown op throws", async () => {
    await expect(runStep(step("anytype", { op: "nope" }), { op: "nope" }, ctx())).rejects.toThrow(/op/);
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run test/workflow-steps.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// src/workflow/steps.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AnytypeClient } from "../anytype/client.js";
import type { Step } from "./schema.js";

const execFileAsync = promisify(execFile) as unknown as (
  cmd: string, args: string[], opts: { cwd?: string; timeout?: number; maxBuffer?: number },
) => Promise<{ stdout: string; stderr?: string }>;

export interface StepContext {
  api: AnytypeClient;
  /** Default space for `anytype` ops that don't name one. */
  spaceId: string;
  /** cwd for `shell`. */
  workspaceDir: string;
  /** Run a one-shot agent bound to `space` and return its text. */
  runAgent: (space: string, prompt: string, tools?: string[]) => Promise<string>;
  fetchFn?: typeof fetch;
  exec?: (cmd: string, opts: { cwd?: string; timeoutMs?: number }) => Promise<{ stdout: string; stderr: string }>;
  log?: (line: string) => void;
}

const MAX_OUT = 8000;
function clip(s: string): string {
  const t = s.trim();
  return t.length > MAX_OUT ? t.slice(0, MAX_OUT) + `\n…（截断，共 ${t.length} 字符）` : t;
}

function str(v: unknown): string {
  return v === undefined || v === null ? "" : String(v);
}

/** Run one (already-rendered) step and return its output text. */
export async function runStep(step: Step, args: Record<string, unknown>, ctx: StepContext): Promise<string> {
  switch (step.uses) {
    case "shell": {
      const run = str(args.run).trim();
      if (!run) throw new Error(`step ${step.id}: shell needs \`run\``);
      const exec = ctx.exec ?? (async (cmd, o) => {
        const r = await execFileAsync("/bin/sh", ["-c", cmd], { cwd: o.cwd, timeout: o.timeoutMs ?? 60000, maxBuffer: 8 * 1024 * 1024 });
        return { stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
      });
      const { stdout } = await exec(run, { cwd: str(args.cwd) || ctx.workspaceDir, timeoutMs: 60000 });
      return clip(stdout);
    }

    case "anytype": {
      const op = str(args.op);
      const space = str(args.space) || ctx.spaceId;
      switch (op) {
        case "read_object": {
          const doc = await ctx.api.getObjectRaw(space, str(args.id));
          return clip(JSON.stringify(doc));
        }
        case "search": {
          const items = await ctx.api.search(space, str(args.query));
          return clip(JSON.stringify(items));
        }
        case "list_objects": {
          const items = await ctx.api.listObjects(space);
          return clip(JSON.stringify(items));
        }
        case "create_note": {
          const created = await ctx.api.createObject(space, { name: str(args.name), markdown: str(args.markdown) });
          return `created ${created.id}`;
        }
        case "send_message": {
          const chat = str(args.chat);
          if (!chat) throw new Error(`step ${step.id}: send_message needs \`chat\``);
          await ctx.api.sendMessage(space, chat, str(args.text), `wf-${step.id}-${Date.now()}`);
          return "sent";
        }
        default:
          throw new Error(`step ${step.id}: unknown anytype op ${JSON.stringify(op)}`);
      }
    }

    case "http": {
      const url = str(args.url);
      if (!url) throw new Error(`step ${step.id}: http needs \`url\``);
      const f = ctx.fetchFn ?? fetch;
      const method = str(args.method) || "GET";
      const init: RequestInit = { method };
      if (args.body !== undefined) init.body = str(args.body);
      if (args.headers && typeof args.headers === "object") init.headers = args.headers as Record<string, string>;
      const res = await f(url, init);
      return clip(await res.text());
    }

    case "agent": {
      const prompt = str(args.prompt).trim();
      if (!prompt) throw new Error(`step ${step.id}: agent needs \`prompt\``);
      const space = str(args.space) || ctx.spaceId;
      const tools = Array.isArray(args.tools) ? (args.tools as string[]) : undefined;
      return clip(await ctx.runAgent(space, prompt, tools));
    }
  }
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run test/workflow-steps.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/workflow/steps.ts test/workflow-steps.test.ts
git commit -m "feat(workflow): step executors (shell/anytype/http/agent)"
```

---

### Task 4: `runner.ts`（顺序 / if / retry / resume / 事件）

**Files:**
- Create: `src/workflow/runner.ts`
- Test: `test/workflow-runner.test.ts`

**Interfaces:**
- Consumes: `WorkflowDef`/`Step`（T1）、`WorkflowRunStore`/`RunState`（T2）、`runStep`/`StepContext`（T3）
- Produces:
  ```ts
  export interface RunOptions {
    store: WorkflowRunStore;
    ctx: StepContext;
    chatId: string;
    spaceId: string;
    trigger: string;
    /** resume an existing run (skip steps already `done`). */
    resumeRunId?: string;
    /** called on每步状态变化（供状态对话投递）。 */
    emit: (event: { runId: string; name: string; stepId?: string; status: string; detail?: string }) => void;
    scope?: Record<string, unknown>;   // extra template vars (e.g. { env })
  }
  export async function runWorkflow(def: WorkflowDef, opts: RunOptions): Promise<RunState>;
  ```

- [ ] **Step 1: 写失败测试**

```ts
// test/workflow-runner.test.ts
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runWorkflow } from "../src/workflow/runner.js";
import { WorkflowRunStore } from "../src/workflow/store.js";
import { parseWorkflow } from "../src/workflow/schema.js";
import type { StepContext } from "../src/workflow/steps.js";

function ctx(exec: (cmd: string) => { stdout: string }): StepContext {
  return { api: {} as never, spaceId: "sp", workspaceDir: "/tmp",
    runAgent: vi.fn(async () => "agent-out"),
    exec: vi.fn(async (cmd: string) => ({ stdout: exec(cmd).stdout, stderr: "" })) };
}
const ROOT = () => fs.mkdtempSync(path.join(os.tmpdir(), "wf-"));

describe("runWorkflow", () => {
  it("runs steps in order, threads outputs into later steps, and marks done", async () => {
    const def = parseWorkflow(`
name: t
steps:
  - { id: a, uses: shell, with: { run: "echo one" } }
  - { id: b, uses: shell, with: { run: "echo got-{{ steps.a.output }}" } }
`);
    const store = new WorkflowRunStore(ROOT());
    const events = [];
    const st = await runWorkflow(def, { store, ctx: ctx((c) => ({ stdout: c.includes("got-") ? "b-done" : "one" })),
      chatId: "c", spaceId: "sp", trigger: "manual", emit: (e) => events.push(e) });
    expect(st.status).toBe("done");
    expect(st.steps.map((s) => s.status)).toEqual(["done", "done"]);
    // b's command saw a's output rendered in.
    const calls = (ctx(() => ({ stdout: "" })).exec) as unknown; // (unused; we assert via store output)
    expect(st.steps[1].output).toBe("b-done");
    expect(events.some((e) => e.status === "done")).toBe(true);
  });

  it("skips a step whose `if` is false", async () => {
    const def = parseWorkflow(`
name: t
steps:
  - { id: a, uses: shell, with: { run: "echo no" } }
  - { id: b, if: "{{ steps.a.output }} == 'yes'", uses: shell, with: { run: "echo b" } }
`);
    const st = await runWorkflow(def, { store: new WorkflowRunStore(ROOT()),
      ctx: ctx(() => ({ stdout: "no" })), chatId: "c", spaceId: "sp", trigger: "manual", emit: () => {} });
    expect(st.steps[1].status).toBe("skipped");
  });

  it("retries a failing step `retry` times, then fails the run", async () => {
    const def = parseWorkflow(`
name: t
steps:
  - { id: a, uses: shell, with: { run: "boom" }, retry: 2 }
`);
    let n = 0;
    const c = ctx(() => { n++; throw new Error("nope"); });
    const st = await runWorkflow(def, { store: new WorkflowRunStore(ROOT()), ctx: c, chatId: "c", spaceId: "sp", trigger: "manual", emit: () => {} });
    expect(n).toBe(3);                 // 1 try + 2 retries
    expect(st.status).toBe("failed");
    expect(st.steps[0].status).toBe("failed");
  });

  it("resume skips steps already done and continues from the first unfinished", async () => {
    const def = parseWorkflow(`
name: t
steps:
  - { id: a, uses: shell, with: { run: "echo a" } }
  - { id: b, uses: shell, with: { run: "echo b" } }
`);
    const store = new WorkflowRunStore(ROOT());
    // seed a run where a is done, b pending
    store.create({ id: "r1", name: "t", chatId: "c", spaceId: "sp", trigger: "manual",
      status: "failed", createdAt: "t", updatedAt: "t",
      steps: [{ id: "a", uses: "shell", status: "done", output: "A!" }, { id: "b", uses: "shell", status: "pending" }] });
    const ran: string[] = [];
    const st = await runWorkflow(def, { store, resumeRunId: "r1",
      ctx: ctx((c) => { ran.push(c); return { stdout: "b" }; }), chatId: "c", spaceId: "sp", trigger: "manual", emit: () => {} });
    expect(ran).toEqual(["echo b"]);   // a not re-run
    expect(st.status).toBe("done");
    expect(st.steps[0].output).toBe("A!"); // preserved
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run test/workflow-runner.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// src/workflow/runner.ts
import { render, evalIf, type WorkflowDef } from "./schema.js";
import { WorkflowRunStore, newRunId, type RunState, type StepState } from "./store.js";
import { runStep, type StepContext } from "./steps.js";

export interface RunEvent {
  runId: string;
  name: string;
  stepId?: string;
  status: string;
  detail?: string;
}
export interface RunOptions {
  store: WorkflowRunStore;
  ctx: StepContext;
  chatId: string;
  spaceId: string;
  trigger: string;
  resumeRunId?: string;
  emit: (event: RunEvent) => void;
  /** Extra template vars (e.g. { env }); merged under `on`/`steps`. */
  scope?: Record<string, unknown>;
}

/** Execute a workflow (or resume one) and return the final run state. */
export async function runWorkflow(def: WorkflowDef, opts: RunOptions): Promise<RunState> {
  const { store } = opts;
  let state: RunState;
  if (opts.resumeRunId) {
    const prev = store.load(opts.resumeRunId);
    if (!prev) throw new Error(`workflow: run ${opts.resumeRunId} not found`);
    state = prev;
    state.status = "running";
  } else {
    state = {
      id: newRunId(),
      name: def.name,
      chatId: opts.chatId,
      spaceId: opts.spaceId,
      trigger: opts.trigger,
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: def.steps.map((s) => ({ id: s.id, uses: s.uses, status: "pending" })),
    };
    store.create(state);
  }
  const byId = new Map<string, StepState>(state.steps.map((s) => [s.id, s]));
  for (const s of def.steps) if (!byId.has(s.id)) { const ns: StepState = { id: s.id, uses: s.uses, status: "pending" }; state.steps.push(ns); byId.set(s.id, ns); }

  store.log(state.id, `▶ run ${state.id} (${def.name}) trigger=${opts.trigger}`);
  opts.emit({ runId: state.id, name: def.name, status: "run-start" });

  const scopeOf = (): Record<string, unknown> => ({
    on: { ...(def.on ?? {}), ...(opts.trigger ? { trigger: opts.trigger } : {}) },
    steps: Object.fromEntries(state.steps.map((s) => [s.id, { output: s.output ?? "" }])),
    ...(opts.scope ?? {}),
  });

  for (const step of def.steps) {
    const ss = byId.get(step.id)!;
    if (ss.status === "done") continue;              // resume: skip finished

    if (step.if !== undefined && !evalIf(render(step.if, scopeOf()))) {
      ss.status = "skipped";
      store.save(state);
      store.log(state.id, `⏭ ${step.id} (if false)`);
      opts.emit({ runId: state.id, name: def.name, stepId: step.id, status: "skipped" });
      continue;
    }

    ss.status = "running";
    ss.startedAt = new Date().toISOString();
    store.save(state);
    opts.emit({ runId: state.id, name: def.name, stepId: step.id, status: "running" });

    const rendered = Object.fromEntries(
      Object.entries(step.with).map(([k, v]) => [k, typeof v === "string" ? render(v, scopeOf()) : v]),
    );

    const attempts = (step.retry ?? 0) + 1;
    let lastErr: unknown;
    let ok = false;
    for (let i = 0; i < attempts; i++) {
      try {
        const out = await runStep(step, rendered, opts.ctx);
        ss.status = "done";
        ss.output = out;
        ss.endedAt = new Date().toISOString();
        delete ss.error;
        store.writeStepOutput(state.id, step.id, out);
        ok = true;
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!ok) {
      ss.status = "failed";
      ss.error = lastErr instanceof Error ? lastErr.message : String(lastErr);
      ss.endedAt = new Date().toISOString();
      state.status = "failed";
      store.save(state);
      store.log(state.id, `❌ ${step.id}: ${ss.error}`);
      opts.emit({ runId: state.id, name: def.name, stepId: step.id, status: "failed", detail: ss.error });
      return state;                                   // abort the run
    }
    store.save(state);
    store.log(state.id, `✅ ${step.id}`);
    opts.emit({ runId: state.id, name: def.name, stepId: step.id, status: "done", detail: ss.output });
  }

  state.status = "done";
  store.save(state);
  store.log(state.id, `✅ run ${state.id} done`);
  opts.emit({ runId: state.id, name: def.name, status: "done" });
  return state;
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run test/workflow-runner.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/workflow/runner.ts test/workflow-runner.test.ts
git commit -m "feat(workflow): runner (order/if/retry/resume + events)"
```

---

### Task 5: `registry.ts` + `ensureWorkflowsConfig`

**Files:**
- Create: `src/workflow/registry.ts`
- Modify: `src/agent/pi-session.ts`（加 `ensureWorkflowsConfig`）
- Modify: `src/main.ts`（boot 时调 `ensureWorkflowsConfig`）
- Test: `test/workflow-registry.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface WorkflowEntry { name: string; description?: string; dir: string; file: string }
  export function listWorkflows(root: string): WorkflowEntry[];      // scan <root>/*/workflow.yaml
  export function loadWorkflow(entry: WorkflowEntry): WorkflowDef;   // read+parse
  export function findWorkflow(root: string, name: string): WorkflowEntry | undefined;
  // pi-session.ts:
  export function ensureWorkflowsConfig(agentDir: string, srcRoot?: string): void;  // mirrors ensureSkillsConfig
  ```

- [ ] **Step 1: 写失败测试**

```ts
// test/workflow-registry.test.ts
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listWorkflows, loadWorkflow, findWorkflow } from "../src/workflow/registry.js";

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "wfreg-"));
  fs.mkdirSync(path.join(d, "demo"));
  fs.writeFileSync(path.join(d, "demo", "workflow.yaml"), "name: demo\nsteps:\n  - { id: a, uses: shell, with: { run: echo hi } }\n");
  fs.mkdirSync(path.join(d, "empty")); // no workflow.yaml → ignored
  return d;
}

describe("workflow registry", () => {
  it("lists dirs that contain workflow.yaml", () => {
    const root = tmp();
    expect(listWorkflows(root).map((e) => e.name)).toEqual(["demo"]);
  });
  it("loadWorkflow parses the def", () => {
    const root = tmp();
    const def = loadWorkflow(findWorkflow(root, "demo")!);
    expect(def.steps[0].id).toBe("a");
  });
  it("findWorkflow returns undefined for unknown", () => {
    expect(findWorkflow(tmp(), "nope")).toBeUndefined();
  });
  it("missing root → empty list", () => {
    expect(listWorkflows(path.join(os.tmpdir(), "no-such-wfroot"))).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run test/workflow-registry.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// src/workflow/registry.ts
import fs from "node:fs";
import path from "node:path";
import { parseWorkflow, type WorkflowDef } from "./schema.js";

export interface WorkflowEntry {
  name: string;
  description?: string;
  dir: string;
  file: string;
}

/** Scan `root` for `<name>/workflow.yaml` dirs. Missing root → []. */
export function listWorkflows(root: string): WorkflowEntry[] {
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: WorkflowEntry[] = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const file = path.join(root, d.name, "workflow.yaml");
    if (!fs.existsSync(file)) continue;
    const entry: WorkflowEntry = { name: d.name, dir: path.join(root, d.name), file };
    try {
      const def = parseWorkflow(fs.readFileSync(file, "utf-8"));
      if (def.description) entry.description = def.description;
    } catch {
      // unparseable — still list it so `/run` can surface the error later
    }
    out.push(entry);
  }
  return out;
}

export function loadWorkflow(entry: WorkflowEntry): WorkflowDef {
  return parseWorkflow(fs.readFileSync(entry.file, "utf-8"));
}

export function findWorkflow(root: string, name: string): WorkflowEntry | undefined {
  return listWorkflows(root).find((e) => e.name === name);
}
```

3b. `src/agent/pi-session.ts` —— 照 `ensureSkillsConfig` 写 `ensureWorkflowsConfig`（拷 `<src>/<name>/workflow.yaml` 与 `README.md`，只补缺）：

```ts
/** Where the baked-in workflows live in the image. */
const WORKFLOWS_SRC = "/app/workflows";

/**
 * Copy baked-in workflows (docker/workflows/<name>/workflow.yaml [+ README.md])
 * into pi's agent dir's `workflows/`. Only fills missing files (never clobbers
 * a user's copies), same volume-mount reason as skills/models.
 */
export function ensureWorkflowsConfig(agentDir: string, srcRoot: string = WORKFLOWS_SRC): void {
  try {
    if (!fs.existsSync(srcRoot)) return;
    const destRoot = path.join(agentDir, "workflows");
    for (const name of fs.readdirSync(srcRoot)) {
      for (const f of ["workflow.yaml", "README.md"]) {
        const src = path.join(srcRoot, name, f);
        const dest = path.join(destRoot, name, f);
        if (fs.existsSync(src) && !fs.existsSync(dest)) {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(src, dest);
          console.log(`wrote workflow: ${dest}`);
        }
      }
    }
  } catch (err) {
    console.warn(`ensureWorkflowsConfig failed: ${String(err)}`);
  }
}
```

3c. `src/main.ts` boot：在 `ensureSkillsConfig(agentDir)` 之后加
```ts
  ensureWorkflowsConfig(agentDir);
```
（并从 `./agent/pi-session.js` 的导入里加上 `ensureWorkflowsConfig`。）

- [ ] **Step 4: 运行，确认通过 + 全量**

Run: `npx vitest run test/workflow-registry.test.ts && npx tsc --noEmit && npx vitest run`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/workflow/registry.ts src/agent/pi-session.ts src/main.ts test/workflow-registry.test.ts
git commit -m "feat(workflow): registry + ensureWorkflowsConfig"
```

---

### Task 6: `/run` + `/runs` 命令

**Files:**
- Modify: `src/commands/handler.ts`
- Test: `test/commands-handler.test.ts`

**Interfaces:**
- Produces（`CommandContext` 加）：
  ```ts
  runWorkflow(name: string, args: string, resume: boolean): Promise<{ ok: boolean; message: string }>;
  listRuns(): { id: string; name: string; status: string; when: string }[];
  ```

- [ ] **Step 1: 写失败测试**（在 `ctx()` 里加两个方法）

```ts
// 在 ctx() 的 context 里加：
  runWorkflow: vi.fn(async () => ({ ok: true, message: "started r1" })),
  listRuns: vi.fn(() => [{ id: "r1", name: "demo", status: "done", when: "t" }]),

// 新增测试：
it("/run <name> delegates to ctx.runWorkflow", async () => {
  const { context, runWorkflow } = ctx(fakeClient());
  const reply = await handleCommand("run", "demo", context);
  expect(runWorkflow).toHaveBeenCalledWith("demo", "", false);
  expect(reply).toContain("started");
});
it("/run <name> --resume <id> sets resume", async () => {
  const { context, runWorkflow } = ctx(fakeClient());
  await handleCommand("run", "demo --resume r9", context);
  expect(runWorkflow).toHaveBeenCalledWith("demo", "", true);
});
it("/run with no arg shows usage", async () => {
  const { context } = ctx(fakeClient());
  expect(await handleCommand("run", "", context)).toMatch(/用法/);
});
it("/runs lists recent runs", async () => {
  const { context } = ctx(fakeClient());
  const reply = await handleCommand("runs", "", context);
  expect(reply).toContain("demo");
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run test/commands-handler.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

3a. `CommandContext` 加：
```ts
  /** Run (or resume) a workflow. `args` are `k=v` pairs; `resume` continues a run. */
  runWorkflow(name: string, args: string, resume: boolean): Promise<{ ok: boolean; message: string }>;
  /** Recent workflow runs (newest first). */
  listRuns(): { id: string; name: string; status: string; when: string }[];
```

3b. 加 case（放在 `case "join"` 附近）：
```ts
    case "run": {
      if (!args) return "用法：/run <工作流名> [k=v …]（/run <名> --resume <runId> 续跑；/runs 看历史）";
      const resumeMatch = args.match(/\s--resume\s+(\S+)/);
      const resume = resumeMatch !== null;
      const name = args.split(/\s+/)[0];
      const rest = args.replace(/^\S+\s*/, "").replace(/--resume\s+\S+/, "").trim();
      const r = await ctx.runWorkflow(name, rest, resume);
      return r.message;
    }
    case "runs": {
      const rows = ctx.listRuns();
      if (rows.length === 0) return "还没有工作流运行记录。";
      return rows.map((r) => `${r.status === "done" ? "✅" : r.status === "failed" ? "❌" : "▶"} ${r.id} ${r.name} (${r.status}) ${r.when}`).join("\n");
    }
```

3c. `HELP_TEXT` 加两行：
```
  "/run <工作流> [k=v …] — 运行一个工作流（--resume <id> 从断点续跑）",
  "/runs — 列出最近的工作流运行",
```

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run test/commands-handler.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/commands/handler.ts test/commands-handler.test.ts
git commit -m "feat(workflow): /run and /runs commands"
```

---

### Task 7: 接线（main）+ 状态对话 + 配置

**Files:**
- Modify: `src/config.ts`、`src/types.ts`、`src/main.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces: `Config.workflowStatusChat?: string`、`Config.workflowDir`（默认 `/app/workflows`）、`Config.workflowRunDir`（默认 `/workspace/workflow-runs`）。

- [ ] **Step 1: 写失败测试**（追加到 `test/config.test.ts`）

```ts
it("parses workflow config with defaults", () => {
  const c = loadConfig({ ANYTYPE_API_BASE_URL: "http://x", ANYTYPE_API_KEY: "k" } as NodeJS.ProcessEnv);
  expect(c.workflowDir).toBe("/app/workflows");
  expect(c.workflowRunDir).toBe("/workspace/workflow-runs");
  expect(c.workflowStatusChat).toBeUndefined();
  const c2 = loadConfig({ ANYTYPE_API_BASE_URL: "http://x", ANYTYPE_API_KEY: "k", WORKFLOW_STATUS_CHAT: "ch9" } as NodeJS.ProcessEnv);
  expect(c2.workflowStatusChat).toBe("ch9");
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

3a. `src/types.ts` 的 `Config` 加：
```ts
  /** Dir holding workflow definitions (env WORKFLOW_DIR). Default /app/workflows. */
  workflowDir: string;
  /** Dir holding per-run state/logs (env WORKFLOW_RUN_DIR). Default /workspace/workflow-runs. */
  workflowRunDir: string;
  /** Chat id for the workflow-status board (env WORKFLOW_STATUS_CHAT). Unset → auto-create. */
  workflowStatusChat?: string;
```
3b. `src/config.ts` 返回对象加：
```ts
    workflowDir: env.WORKFLOW_DIR || "/app/workflows",
    workflowRunDir: env.WORKFLOW_RUN_DIR || path.join(env.AGENT_WORKSPACE_ROOT || "/workspace", "workflow-runs"),
    workflowStatusChat: env.WORKFLOW_STATUS_CHAT || undefined,
```
（`src/config.ts` 顶部若无 `import path from "node:path"` 则加上。）
3c. `src/main.ts` 接线：
- 建 `const runStore = new WorkflowRunStore(cfg.workflowRunDir);` 与 `const stepCtx: StepContext = { api, spaceId: <触发聊天所在空间则动态>, workspaceDir: cfg.agentWorkspaceRoot, runAgent: (space, prompt) => runAgentInSpace(space, prompt) };`（`runAgentInSpace` 见 T5 的 console worker 复用——直接实现 `(space,prompt)=>runSpaceWorker(space,prompt)`）。
- **状态对话**：`const statusChatId = cfg.workflowStatusChat;`（未设则先跳过自动建，留 TODO→本任务实现"首次需要时 `api.createChat(spaceId,"workflow")` 并缓存到内存"）。`emit` 里把事件发到 `statusChatId`（若有）。
- `CommandContext` 加 `runWorkflow`/`listRuns`：
```ts
  const doRun = async (name: string, args: string, resume: boolean) => {
    const entry = findWorkflow(cfg.workflowDir, name);
    if (!entry) return { ok: false, message: `未知工作流：${name}（可用：${listWorkflows(cfg.workflowDir).map((e) => e.name).join(", ") || "无"}）` };
    try {
      const def = loadWorkflow(entry);
      const spaceId = chatTargets.get(<当前 chat>)?.spaceId ?? "";
      const state = await runWorkflow(def, { store: runStore, ctx: stepCtx, chatId: <chat>, spaceId, trigger: resume ? "resume" : "manual", resumeRunId: resume ? args : undefined, emit });
      return { ok: state.status === "done", message: `工作流 ${name} ${state.status === "done" ? "✅ 完成" : "❌ " + state.status}（run ${state.id}）` };
    } catch (err) { return { ok: false, message: `工作流失败：${err instanceof Error ? err.message : String(err)}` }; }
  };
```
  （`<chat>` = 命令所在 `e.chatId`；`args` 里 `--resume` 后面是 runId，需在 T6 解析时把 runId 传来——为简单起见：`--resume <id>` 时把 `id` 作为 `args` 传进 `runWorkflow` 的第 2 参并置 `resume=true`。）
- `emit` 实现：`store.log` 已在 runner 内；`emit` 只负责把事件发到状态对话（若 `statusChatId` 且是生命周期事件）：`api.sendMessage(statusSpaceId, statusChatId, text, key)`。`statusSpaceId` 需知道——状态对话属于哪个空间：若 `cfg.workflowStatusChat` 给了 id 但不知空间，则在 `discover()` 时把 chat→space 存进 `chatTargets`，查不到就不发。
- `CommandContext` 的对象字面量里加 `runWorkflow: (n, a, r) => doRun(n, a, r), listRuns: () => [...最近 N 条...]`。

- [ ] **Step 4: 编译 + 全量**

Run: `npx tsc --noEmit && npm run build && npx vitest run`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add src/config.ts src/types.ts src/main.ts test/config.test.ts
git commit -m "feat(workflow): wire /run + status board + config (main)"
```

---

### Task 8: cron 触发

**Files:**
- Modify: `src/main.ts`
- Test: 无单测（复用已验证的 `cronMatches`；实机验证）

**Interfaces:**
- Consumes: `cronMatches`（`src/watch/cron.ts`）、`listWorkflows`/`loadWorkflow`、`runWorkflow`

- [ ] **Step 1: 实现**

在 main 的 watch tick（`setInterval(...)` 里 `pollDueWatches`）**之外**，加一个**独立的**工作流 cron tick（同一 60s 节奏，独立文件以免干扰 watch）：用 `cronMatches(def.on.cron, now)` + 一个内存 `lastFiredMinute`（per workflow，仿 watch）防重入；命中即 `runWorkflow(def, { trigger: "cron", chatId: def.on.notify ?? "", ... })`，结果发到 `on.notify`。

```ts
  // Workflow cron: each workflow whose on.cron matches the current local minute
  // runs once (guarded per minute). Independent of the object-watch scheduler.
  const wfFiredMinute = new Map<string, string>();
  const wfTimer = setInterval(() => {
    const now = new Date();
    const key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}T${now.getHours()}:${now.getMinutes()}`;
    for (const entry of listWorkflows(cfg.workflowDir)) {
      let def; try { def = loadWorkflow(entry); } catch { continue; }
      const cron = def.on?.cron;
      if (!cron || !cronMatches(cron, now)) continue;
      if (wfFiredMinute.get(entry.name) === key) continue;
      wfFiredMinute.set(entry.name, key);
      const notify = def.on?.notify ?? "";
      void runWorkflow(def, { store: runStore, ctx: stepCtx, chatId: notify, spaceId: chatTargets.get(notify)?.spaceId ?? "", trigger: "cron", emit })
        .catch((err) => console.warn(`workflow cron '${entry.name}' failed: ${String(err)}`));
    }
  }, cfg.watchTickMs);
```
并在 shutdown 里 `clearInterval(wfTimer);`。（`cronMatches` 从 `./watch/cron.js` 导入。）

- [ ] **Step 2: 编译 + 全量**

Run: `npx tsc --noEmit && npm run build && npx vitest run`
Expected: 全绿

- [ ] **Step 3: 提交**

```bash
git add src/main.ts
git commit -m "feat(workflow): cron trigger (reusing the cron matcher)"
```

---

### Task 9: 文档 + 部署 + 实机验证

**Files:** `docs/RUNBOOK.md`、`CLAUDE.md`、`README.zh-CN.md`；`Dockerfile`（`COPY docker/workflows /app/workflows`）

- [ ] **Step 1: Dockerfile**

在 `COPY docker/skills /app/skills` 之后加 `COPY docker/workflows /app/workflows`。

- [ ] **Step 2: 文档**

- `RUNBOOK.md`：加「工作流」一节——`docker/workflows/<name>/workflow.yaml` 的字段、4 种步骤、`/run` `/runs`、run 目录 `/workspace/workflow-runs/<id>/`、状态对话（`WORKFLOW_STATUS_CHAT`）、cron 触发、`--resume`。
- `CLAUDE.md`：Key facts 加一条——引擎编排的 workflow（`src/workflow/*`），步骤 `shell/anytype/http/agent`，仅 agent 步骤调模型；`ensureWorkflowsConfig` 拷 `docker/workflows/*`。
- `README.zh-CN.md`：能力列表加一句「**工作流** —— 像 GitHub Actions 一样按序执行确定性步骤，仅必要时调用 AI（`/run`）」。

- [ ] **Step 3: 构建 + 部署**

```bash
npm run build && docker build -t anytype-ai-bot:latest .
cd /home/landspace/anytype && docker compose -f docker-compose.yml -f /home/landspace/anytype-ai-bot/docker-compose.bot.yml up -d --force-recreate --no-deps ai-bot
```

- [ ] **Step 4: 实机验证（dev-test）**

在 `dev-test` 放一个测试工作流（`docker/workflows/demo/workflow.yaml`，含 `shell` + `anytype create_note` + `agent` 三步），`/run demo` → 观察每步状态；把某步改错再 `/run demo --resume <id>` 验证续跑。`docker logs --tail 40 anytype-ai-bot-1`

- [ ] **Step 5: 提交**

```bash
git add Dockerfile docs/RUNBOOK.md CLAUDE.md README.zh-CN.md
git commit -m "docs: workflows (engine-orchestrated, /run)"
```

---

## 自检记录

- **Spec 覆盖**：§2 定义格式 → T1（schema）+T5（registry）；§3 步骤类型 → T3；§4 run/状态/续跑 → T2（store）+T4（runner）；§5 触发 → T6（手动）+T8（cron）；§6 结果+状态对话 → T7；§7 安全 → T3（写步骤）+T7（沿用闸门）；§8 组件 → 各任务 Files；§9 测试 → 各任务测试步 + T9 实机。未覆盖项：无（消息/对象变化触发按 §10 非目标）。
- **占位符扫描**：无 TBD；T1/T2/T3/T4/T5 给完整实现与测试；T6 给完整 case 与测试；T7/T8 给完整接线代码片段（`emit`/`doRun`/cron tick）。
- **一致性**：`WorkflowDef`/`Step`（T1）、`RunState`/`StepState`/`WorkflowRunStore`（T2）、`runStep`/`StepContext`（T3）、`runWorkflow`/`RunOptions`（T4）、`listWorkflows`/`findWorkflow`/`loadWorkflow`（T5）、`runWorkflow`/`listRuns`（CommandContext，T6）全链一致。
- **风险**：新增依赖 `yaml`（ISC，零依赖）——spec 要求 YAML 格式，无可避免；`Dockerfile` 需 `COPY docker/workflows`（T9）否则镜像里没有定义；T7 的状态对话在 `cfg.workflowStatusChat` 未设时**不做自动建群**（留待后续），先只在显式配置时投递（避免范围膨胀）。
