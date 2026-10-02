# 全局助手（控制台）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 bot 拥有一个「控制台」（专门的 1:1 空间），在其中能跨空间只读、读全局 memory、接受加入链接；其他空间行为不变。

**Architecture:** 控制台由 `console.json`（或 `CONSOLE_SPACE_ID`）标识，**零配置**——引导成功后自动记下。控制台会话的工具集被替换为**严格只读集 + 少量全局工具**（无任何写工具 → 模型无法写）。全局能力全部通过 `createAnytypeTools` 的**可选 `console` dep** 开关，普通会话完全不受影响。阶段 2 增加对 anytype-heart 的 gRPC 桥（明文 h2c + `token` metadata），用于镜像 1:1 空间与 `SpaceJoin`。

**Tech Stack:** TypeScript (NodeNext, strict)、vitest、内嵌 pi SDK、`@grpc/grpc-js` + `@grpc/proto-loader`（仅阶段 2）。

## Global Constraints

- 包管理器/脚本：`npm run build`（`tsc`）、`npm test`（`vitest run`）。单文件：`npx vitest run test/<file>.test.ts`。
- **只读必须由"不注册写工具"强制**，不靠提示词。
- **绝不调用** `WorkspaceGetAll` 之类 `panic("should be removed")` 的 gRPC 桩——会打死 anytype-cli。只用已验证的真 handler：`WorkspaceCreate`、`AppGetVersion`（`SpaceJoin` 用前需先确认字段号）。
- 实机验证必须 `docker run` **新镜像**；`docker exec` 进运行中的容器测的是旧镜像。
- 追加 `src/` 文件到 `tsconfig` 的 `include: ["src"]` 已覆盖，无需改配置。
- 提交信息用英文，遵循仓库既有的 `feat:/fix:/docs:/test:` 风格。

## 文件结构

**阶段 1（新增/改动）**

| 文件 | 责任 |
|---|---|
| `src/console/console-store.ts`（新） | `console.json` 读写（`readConsole` / `writeConsole`） |
| `src/agent/anytype-tools.ts`（改） | 加可选 `console` dep；跨空间 `space` 参数；`anytype_list_spaces`；`anytype_memories` |
| `src/config.ts` / `src/types.ts`（改） | `consoleSpaceId`（env `CONSOLE_SPACE_ID`） |
| `src/agent/pi-session.ts`（改） | `CONSOLE_TOOLS` 工具集；`createPiClient` 接受 `isConsole`；控制台 cwd=`_global` |
| `src/main.ts`（改） | 读 `console.json`/env → `isConsole(spaceId)`；控制台 workspace=`_global`；传 `console` dep |

**阶段 2（新增/改动）**

| 文件 | 责任 |
|---|---|
| `src/console/links.ts`（新） | 解析 Anytype 链接（邀请 / 1:1） |
| `src/anytype/grpc.ts`（新） | anytype-heart gRPC 客户端（token 读取、workspaceCreate、spaceJoin） |
| `proto/anytype.proto`（新） | 最小 proto（仅所需消息） |
| `src/console/bootstrap.ts`（新） | 镜像 1:1 / 生成 bot 链接 / 从链接加入 |
| `src/commands/handler.ts` + `src/main.ts`（改） | `/join <link>` 桥指令（bootstrap 前也能用） |
| `Dockerfile`（改） | COPY `proto/`；安装 gRPC 依赖（随 `npm ci`） |

---

# 阶段 1

### Task 1: 控制台状态文件（`console.json`）

**Files:**
- Create: `src/console/console-store.ts`
- Test: `test/console-store.test.ts`

**Interfaces:**
- Produces:
  - `interface ConsoleRecord { spaceId: string; chatId?: string; bootstrappedAt: string }`
  - `readConsole(file: string): ConsoleRecord | null`
  - `writeConsole(file: string, rec: ConsoleRecord): void`

- [ ] **Step 1: 写失败测试**

```ts
// test/console-store.test.ts
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readConsole, writeConsole } from "../src/console/console-store.js";

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "console-")), "console.json");
}

describe("console store", () => {
  it("round-trips a record", () => {
    const f = tmpFile();
    writeConsole(f, { spaceId: "abc", chatId: "c1", bootstrappedAt: "2026-10-02T00:00:00Z" });
    expect(readConsole(f)).toEqual({ spaceId: "abc", chatId: "c1", bootstrappedAt: "2026-10-02T00:00:00Z" });
  });

  it("returns null when the file is missing", () => {
    expect(readConsole(path.join(os.tmpdir(), "nope-does-not-exist.json"))).toBeNull();
  });

  it("returns null on a malformed record (missing spaceId)", () => {
    const f = tmpFile();
    fs.writeFileSync(f, JSON.stringify({ chatId: "c1" }));
    expect(readConsole(f)).toBeNull();
  });

  it("returns null on invalid JSON", () => {
    const f = tmpFile();
    fs.writeFileSync(f, "{not json");
    expect(readConsole(f)).toBeNull();
  });

  it("writes pretty JSON and creates parent dirs", () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "console-")), "nested", "console.json");
    writeConsole(f, { spaceId: "abc", bootstrappedAt: "t" });
    expect(fs.readFileSync(f, "utf-8")).toContain('"spaceId": "abc"');
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run test/console-store.test.ts`
Expected: FAIL（`Cannot find module '../src/console/console-store.js'`）

- [ ] **Step 3: 实现**

```ts
// src/console/console-store.ts
import fs from "node:fs";
import path from "node:path";

/** The console's persisted identity: the one-to-one space that carries global powers. */
export interface ConsoleRecord {
  spaceId: string;
  /** The space's chat id (informational; discovery re-resolves it anyway). */
  chatId?: string;
  /** ISO timestamp of when the console was bootstrapped. */
  bootstrappedAt: string;
}

/** Read the console record, or null when absent/unreadable/malformed. */
export function readConsole(file: string): ConsoleRecord | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
    if (typeof raw.spaceId !== "string" || raw.spaceId.length === 0) return null;
    const rec: ConsoleRecord = {
      spaceId: raw.spaceId,
      bootstrappedAt: typeof raw.bootstrappedAt === "string" ? raw.bootstrappedAt : "",
    };
    if (typeof raw.chatId === "string") rec.chatId = raw.chatId;
    return rec;
  } catch {
    return null;
  }
}

/** Write the console record (pretty JSON; creates parent dirs). */
export function writeConsole(file: string, rec: ConsoleRecord): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(rec, null, 2), "utf-8");
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run test/console-store.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 5: 提交**

```bash
git add src/console/console-store.ts test/console-store.test.ts
git commit -m "feat(console): persist the console space in console.json"
```

---

### Task 2: 跨空间只读（`space` 参数 + `anytype_list_spaces`）

**Files:**
- Modify: `src/agent/anytype-tools.ts`（deps 加 `console?`；新 helper `resolveSpaceId`；`listObjects`/`search`/`readObject` 加 `space` 参数；新增 `listSpaces` 工具）
- Test: `test/console-tools.test.ts`

**Interfaces:**
- Consumes: `AnytypeClient.listSpaces(): Promise<Array<{id:string;name:string}>>`（已存在）
- Produces:
  - deps 新增可选字段 `console?: { workspaceRoot: string }`（`workspaceRoot` 供 Task 3 用；本任务先建立该开关）
  - `resolveSpaceId(api: AnytypeClient, value: string | undefined, fallback: string): Promise<string>` — 空值→fallback；命中 id→原样；否则按**名字**在 `api.listSpaces()` 里精确匹配；都无 → fallback
  - 工具 `anytype_list_spaces`（仅当 `deps.console` 存在时注册）

- [ ] **Step 1: 写失败测试**

```ts
// test/console-tools.test.ts
import { describe, it, expect, vi } from "vitest";
import { createAnytypeTools, resolveSpaceId } from "../src/agent/anytype-tools.js";
import type { AnytypeClient } from "../src/anytype/client.js";
import type { WatchStore } from "../src/watch/store.js";

const SPACES = [
  { id: "spA", name: "考试" },
  { id: "spB", name: "emotions" },
];
function fakeApi(over: Partial<AnytypeClient> = {}): AnytypeClient {
  return {
    listSpaces: vi.fn(async () => SPACES),
    listObjects: vi.fn(async () => []),
    search: vi.fn(async () => []),
    getObjectRaw: vi.fn(async () => null),
    ...over,
  } as unknown as AnytypeClient;
}
function baseDeps(api: AnytypeClient, withConsole?: boolean) {
  return {
    api,
    spaceId: "spA",
    workspaceDir: "/tmp/ws",
    store: { list: () => [] } as unknown as WatchStore,
    chatId: "c1",
    defaultWatchCron: "*/30 * * * *",
    searchApiKey: "",
    ...(withConsole ? { console: { workspaceRoot: "/tmp/ws" } } : {}),
  };
}
function toolNames(tools: { name: string }[]): string[] {
  return tools.map((t) => t.name).sort();
}

describe("resolveSpaceId", () => {
  it("returns the fallback for empty input", async () => {
    expect(await resolveSpaceId(fakeApi(), undefined, "spA")).toBe("spA");
    expect(await resolveSpaceId(fakeApi(), "", "spA")).toBe("spA");
  });

  it("passes through an exact id", async () => {
    expect(await resolveSpaceId(fakeApi(), "spB", "spA")).toBe("spB");
  });

  it("resolves a name to its id", async () => {
    expect(await resolveSpaceId(fakeApi(), "emotions", "spA")).toBe("spB");
  });

  it("falls back on an unknown name", async () => {
    expect(await resolveSpaceId(fakeApi(), "nope", "spA")).toBe("spA");
  });
});

describe("console tool gating", () => {
  it("does NOT expose anytype_list_spaces in a normal session", () => {
    const tools = createAnytypeTools(baseDeps(fakeApi()));
    expect(toolNames(tools)).not.toContain("anytype_list_spaces");
  });

  it("exposes anytype_list_spaces in a console session", () => {
    const tools = createAnytypeTools(baseDeps(fakeApi(), true));
    expect(toolNames(tools)).toContain("anytype_list_spaces");
  });

  it("anytype_list_spaces lists spaces with ids", async () => {
    const tools = createAnytypeTools(baseDeps(fakeApi(), true));
    const t = tools.find((x) => x.name === "anytype_list_spaces")!;
    const res = await t.execute("id", {});
    const text = (res.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("考试");
    expect(text).toContain("spA");
    expect(text).toContain("spB");
  });
});

describe("cross-space read", () => {
  it("anytype_list_objects honours a `space` id", async () => {
    const listObjects = vi.fn(async (sid: string) => [{ id: `${sid}-1`, name: "n", type: "page" }]);
    const tools = createAnytypeTools(baseDeps(fakeApi({ listObjects } as Partial<AnytypeClient>), true));
    const t = tools.find((x) => x.name === "anytype_list_objects")!;
    await t.execute("id", { space: "spB" });
    expect(listObjects).toHaveBeenCalledWith("spB");
  });

  it("anytype_read_object honours a `space` name", async () => {
    const getObjectRaw = vi.fn(async (sid: string) => ({ id: `${sid}-obj` }));
    const tools = createAnytypeTools(baseDeps(fakeApi({ getObjectRaw } as Partial<AnytypeClient>), true));
    const t = tools.find((x) => x.name === "anytype_read_object")!;
    await t.execute("id", { id: "obj1", space: "emotions" });
    expect(getObjectRaw).toHaveBeenCalledWith("spB", "obj1");
  });

  it("a normal session passes no `space` and stays on its own space", async () => {
    const listObjects = vi.fn(async (sid: string) => []);
    const tools = createAnytypeTools(baseDeps(fakeApi({ listObjects } as Partial<AnytypeClient>)));
    const t = tools.find((x) => x.name === "anytype_list_objects")!;
    await t.execute("id", { space: "spB" }); // param ignored when not console? -> see impl note
    expect(listObjects).toHaveBeenCalledWith("spA");
  });
});
```

> 注：第三个断言故意检查"普通会话即使传了 `space` 也仍用本空间"——实现上普通会话**不注册** `space` 参数（参数被 schema 忽略 → 走 fallback）。这样语义安全。

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run test/console-tools.test.ts`
Expected: FAIL（`resolveSpaceId` 未导出 / 工具不存在）

- [ ] **Step 3: 实现**

在 `src/agent/anytype-tools.ts` 中：

3a. 在 deps 类型里新增字段（放在 `agentRegistry?` 之后）：

```ts
  /**
   * When set, this session is the GLOBAL CONSOLE: cross-space read tools and
   * the memory aggregate are registered. Absent for normal sessions, which
   * stay confined to `spaceId`.
   */
  console?: {
    /** Root dir holding per-space workspaces (`/workspace`). */
    workspaceRoot: string;
  };
```

并在解构处加 `console: consoleDep,`。

3b. 在文件里（`isContentObject` 附近）新增导出 helper：

```ts
/**
 * Resolve a space reference to an id. Empty → fallback. An exact id passes
 * through. Otherwise it is matched (exact, case-insensitive) against space
 * NAMES via listSpaces; no match → fallback. Never throws.
 */
export async function resolveSpaceId(
  api: AnytypeClient,
  value: string | undefined,
  fallback: string,
): Promise<string> {
  const v = (value ?? "").trim();
  if (v.length === 0) return fallback;
  try {
    const spaces = await api.listSpaces();
    if (spaces.some((s) => s.id === v)) return v;
    const lower = v.toLowerCase();
    const byName = spaces.find((s) => (s.name ?? "").toLowerCase() === lower);
    if (byName) return byName.id;
  } catch {
    // fall through to fallback
  }
  return fallback;
}
```

3c. 给 `listObjects` / `search` / `readObject` 三个工具加 `space` 参数（**仅当 `consoleDep` 存在**），并把 `execute` 里的 `spaceId` 换成解析后的值：

```ts
// listObjects parameters 增加：
      ...(consoleDep
        ? { space: Type.Optional(Type.String({ description: "Optional space id or name to read from (default: the current space)." })) }
        : {}),
// execute 开头：
        const target = await resolveSpaceId(api, consoleDep ? (params as { space?: string }).space : undefined, spaceId);
// 把下面出现的 spaceId 换成 target（listObjectsOfType / listObjects）
```

对 `search`：`filteredSearch(target, …)` / `search(target, …)`。
对 `readObject`：`getObjectRaw(target, params.id)` 与 `downloadFileContent(target, …)`。

3d. 新增 `listSpaces` 工具（在 `tools` 数组**之前**定义，仿照 `listObjects`）：

```ts
  const listSpaces = defineTool({
    name: "anytype_list_spaces",
    label: "List Anytype spaces",
    description:
      "List every Anytype space this assistant has joined (id + name). Use a returned id/name as the `space` argument of anytype_list_objects / anytype_search / anytype_read_object to read from that space.",
    promptSnippet: "anytype_list_spaces — list all joined spaces (id + name)",
    promptGuidelines: GUIDELINES,
    parameters: Type.Object({}),
    async execute() {
      try {
        const spaces = await api.listSpaces();
        if (spaces.length === 0) return textResult("No spaces.");
        return textResult(spaces.map((s) => `${s.name || "(unnamed)"} — ${s.id}`).join("\n"));
      } catch (err) {
        return textResult(`anytype_list_spaces failed: ${errMessage(err)}`);
      }
    },
  });
```

3e. 在 `tools` 数组组装处，仅当 `consoleDep` 时加入：

```ts
  if (consoleDep) tools.push(listSpaces);
```

（`tools` 数组在 `1522` 行附近；`as ToolDefinition[]` 后再 push 是既有模式。）

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run test/console-tools.test.ts && npx tsc --noEmit`
Expected: PASS（10 tests），无类型错误

- [ ] **Step 5: 提交**

```bash
git add src/agent/anytype-tools.ts test/console-tools.test.ts
git commit -m "feat(console): cross-space read (space param + anytype_list_spaces)"
```

---

### Task 3: 全局 memory 汇总（`anytype_memories`）

**Files:**
- Modify: `src/agent/anytype-tools.ts`（新增 `anytype_memories` 工具；由 `console` dep 门控）
- Test: `test/console-tools.test.ts`（追加）

**Interfaces:**
- Consumes: `deps.console.workspaceRoot`；`AnytypeClient.listSpaces()`
- Produces: 工具 `anytype_memories`（仅 console 注册）；纯 helper `collectMemories(workspaceRoot: string): Array<{spaceId: string; text: string}>`

- [ ] **Step 1: 写失败测试**（追加到 `test/console-tools.test.ts`）

```ts
import { collectMemories } from "../src/agent/anytype-tools.js";

describe("collectMemories", () => {
  it("reads _global plus each space dir, skipping dirs without MEMORY.md", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wsroot-"));
    fs.mkdirSync(path.join(root, "_global"), { recursive: true });
    fs.writeFileSync(path.join(root, "_global", "MEMORY.md"), "global note");
    fs.mkdirSync(path.join(root, "spA"), { recursive: true });
    fs.writeFileSync(path.join(root, "spA", "MEMORY.md"), "space A note");
    fs.mkdirSync(path.join(root, "empty"), { recursive: true }); // no MEMORY.md
    const got = collectMemories(root).map((m) => m.spaceId).sort();
    expect(got).toEqual(["_global", "spA"]);
    const g = collectMemories(root).find((m) => m.spaceId === "_global")!;
    expect(g.text).toContain("global note");
  });

  it("returns [] for a missing root", () => {
    expect(collectMemories(path.join(os.tmpdir(), "no-such-root-xyz"))).toEqual([]);
  });
});
```

并在文件顶部补 `import fs from "node:fs"; import os from "node:os"; import path from "node:path";`。

再加一条工具层测试：

```ts
  it("anytype_memories is only in console sessions and labels each block", async () => {
    expect(toolNames(createAnytypeTools(baseDeps(fakeApi())))).not.toContain("anytype_memories");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wsroot2-"));
    fs.mkdirSync(path.join(root, "_global"), { recursive: true });
    fs.writeFileSync(path.join(root, "_global", "MEMORY.md"), "hello-global");
    const deps = { ...baseDeps(fakeApi(), false), console: { workspaceRoot: root } };
    const tools = createAnytypeTools(deps);
    const t = tools.find((x) => x.name === "anytype_memories")!;
    const text = ((await t.execute("id", {})).content[0] as { text: string }).text;
    expect(text).toContain("hello-global");
    expect(text).toContain("_global");
  });
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run test/console-tools.test.ts`
Expected: FAIL（`collectMemories` 未导出）

- [ ] **Step 3: 实现**

3a. 在 `anytype-tools.ts` 顶部确保有 `import fs from "node:fs";`（已存在）与 `import path from "node:path";`（已存在）。

3b. 新增导出 helper：

```ts
/**
 * Read every workspace's MEMORY.md under `root`: the global one (`_global/`)
 * plus each space dir. Returns [{spaceId, text}], skipping dirs without a
 * MEMORY.md and non-directory entries. Never throws.
 */
export function collectMemories(root: string): Array<{ spaceId: string; text: string }> {
  const out: Array<{ spaceId: string; text: string }> = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const file = path.join(root, e.name, "MEMORY.md");
    try {
      out.push({ spaceId: e.name, text: fs.readFileSync(file, "utf-8") });
    } catch {
      // no MEMORY.md here — skip
    }
  }
  return out;
}
```

3c. 新增工具（放在 `listSpaces` 定义之后）：

```ts
  const memories = defineTool({
    name: "anytype_memories",
    label: "Read memories",
    description:
      "Read the assistant's durable memories: the global MEMORY.md plus every per-space MEMORY.md, each labelled with its space name. Use this to recall what has been recorded anywhere.",
    promptSnippet: "anytype_memories — read global + per-space memories",
    promptGuidelines: GUIDELINES,
    parameters: Type.Object({}),
    async execute() {
      try {
        const root = consoleDep!.workspaceRoot;
        const items = collectMemories(root);
        if (items.length === 0) return textResult("(no memories recorded yet)");
        const names = new Map((await api.listSpaces()).map((s) => [s.id, s.name]));
        const blocks = items.map((m) => {
          const label = m.spaceId === "_global" ? "全局 (global)" : `${names.get(m.spaceId) || m.spaceId}`;
          return `## ${label} [${m.spaceId}]\n${m.text.trim()}`;
        });
        return textResult(blocks.join("\n\n"));
      } catch (err) {
        return textResult(`anytype_memories failed: ${errMessage(err)}`);
      }
    },
  });
```

3d. 组装处：`if (consoleDep) tools.push(listSpaces, memories);`（替换 Task 2 里的单元素 push）。

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run test/console-tools.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/agent/anytype-tools.ts test/console-tools.test.ts
git commit -m "feat(console): anytype_memories (global + per-space aggregate)"
```

---

### Task 4: 控制台识别与接线（config / main / pi-session）

**Files:**
- Modify: `src/types.ts`（`Config.consoleSpaceId?`）
- Modify: `src/config.ts`（解析 `CONSOLE_SPACE_ID`）
- Modify: `src/agent/pi-session.ts`（`CONSOLE_TOOLS`；`createPiClient` 接受 `isConsole`；`ensureAgentFiles` 复用于 `_global`）
- Modify: `src/main.ts`（读 `console.json`/env；`workspaceFor` 对控制台用 `_global`；`createClient` 传 `isConsole` 与 `console` dep）
- Test: `test/config.test.ts`（追加）、`test/pi-session.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 `readConsole/writeConsole`；Task 2/3 的 `console` dep
- Produces:
  - `Config.consoleSpaceId?: string`
  - `export const CONSOLE_TOOLS: readonly string[]`（pi-session）
  - `PiClientOptions.isConsole?: boolean`
  - `main` 内 `isConsoleSpace(spaceId: string): boolean`

- [ ] **Step 1: 写失败测试**

config（追加到 `test/config.test.ts`）：

```ts
it("parses CONSOLE_SPACE_ID when set", () => {
  const cfg = loadConfig({
    ANYTYPE_API_BASE_URL: "http://x", ANYTYPE_API_KEY: "k", CONSOLE_SPACE_ID: "  xy7 ",
  } as NodeJS.ProcessEnv);
  expect(cfg.consoleSpaceId).toBe("xy7");
});
it("leaves consoleSpaceId undefined when unset", () => {
  const cfg = loadConfig({
    ANYTYPE_API_BASE_URL: "http://x", ANYTYPE_API_KEY: "k",
  } as NodeJS.ProcessEnv);
  expect(cfg.consoleSpaceId).toBeUndefined();
});
```

> 该文件既有风格是内联 env 对象（无 `minimalEnv()`）；照此写。

pi-session（追加到 `test/pi-session.test.ts`）：

```ts
import { CONSOLE_TOOLS } from "../src/agent/pi-session.js";

describe("CONSOLE_TOOLS", () => {
  it("contains read tools and global tools, and NO write tools", () => {
    expect(CONSOLE_TOOLS).toContain("anytype_read_object");
    expect(CONSOLE_TOOLS).toContain("anytype_search");
    expect(CONSOLE_TOOLS).toContain("anytype_list_spaces");
    expect(CONSOLE_TOOLS).toContain("anytype_memories");
    for (const w of [
      "anytype_create_note", "anytype_update_object", "anytype_delete_object",
      "anytype_edit_object", "anytype_send_message", "anytype_upload_file",
      "anytype_watch", "anytype_set_property",
    ]) {
      expect(CONSOLE_TOOLS).not.toContain(w);
    }
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run test/config.test.ts test/pi-session.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

3a. `src/types.ts`：在 `Config` 里加

```ts
  /** Explicit console space id (env CONSOLE_SPACE_ID). Overrides console.json. */
  consoleSpaceId?: string;
```

3b. `src/config.ts`：在返回对象里加

```ts
    consoleSpaceId: env.CONSOLE_SPACE_ID?.trim() || undefined,
```

3c. `src/agent/pi-session.ts`：

- `PiClientOptions` 加

```ts
  /** True for the global-console session: read-only tool set, global workspace. */
  isConsole?: boolean;
```

- 新增导出常量（放在 `READONLY_TOOLS` 之后）：

```ts
/**
 * Tool set for the CONSOLE session: read-only reads plus the global tools.
 * Deliberately excludes EVERY mutating tool (create/update/delete/edit/send/
 * upload/watch/collection/type/property/template), so the model physically
 * cannot write. Enforced by omission, not by prompt.
 */
export const CONSOLE_TOOLS: readonly string[] = [
  "read", "ls", "grep", "find",
  "anytype_list_spaces",
  "anytype_list_objects",
  "anytype_search",
  "anytype_read_object",
  "anytype_download_images",
  "anytype_download_file",
  "anytype_memories",
  "crop_image",
  "anytype_list_properties",
  "anytype_list_types",
  "web_search",
  "web_fetch",
];
```

- `applyTools` 改为按 `isConsole` 选集合。**控制台无条件只读**（与 YOLO 开关无关）——抽一个纯函数以便单测：

```ts
/** Effective tool names for a session. Console is ALWAYS read-only (YOLO cannot widen it). */
export function effectiveToolNames(o: {
  isConsole: boolean;
  autoTools: boolean;
  allToolNames: string[];
}): string[] {
  if (o.isConsole) return [...CONSOLE_TOOLS];
  return o.autoTools ? [...o.allToolNames] : [...READONLY_TOOLS];
}
```

```ts
  const applyTools = (): void => {
    session.setActiveToolsByName(
      effectiveToolNames({
        isConsole: opts.isConsole === true,
        autoTools,
        allToolNames: session.getAllTools().map((t) => t.name),
      }),
    );
  };
```

- `setAutoTools`（`/yolo`）在控制台会话里**不改变工具集**，只回报"控制台始终只读":

```ts
    setAutoTools(enabled: boolean): string {
      if (opts.isConsole) return "控制台始终只读（/yolo 在此无效）";
      autoTools = enabled;
      applyTools();
      return enabled ? "YOLO 自动模式：开" : "YOLO 自动模式：关";
    },
```

- 顶层会话创建时，把 `console` dep 传下去（**仅当 `opts.isConsole`**），并在 cwd 上不额外处理（cwd 由 main 传 `_global`）：

```ts
      customTools: createAnytypeTools({
        // …既有字段…
        ...(opts.isConsole ? { console: { workspaceRoot: opts.agentWorkspaceRoot! } } : {}),
      }),
```

（新增 `PiClientOptions.agentWorkspaceRoot?: string`，由 main 传 `cfg.agentWorkspaceRoot`。）**子会话**（`createChildAgent`）**不传** `console`，保持受限。

3d. `src/main.ts`：

- 导入：`import { readConsole } from "./console/console-store.js";`
- boot 时解析控制台空间：

```ts
  const consoleFile = path.join(cfg.agentWorkspaceRoot, "console.json");
  const consoleRec = readConsole(consoleFile);
  const consoleSpaceId = cfg.consoleSpaceId ?? consoleRec?.spaceId;
  const isConsoleSpace = (spaceId: string): boolean => !!consoleSpaceId && spaceId === consoleSpaceId;
```

- `workspaceFor` 调用处（`createClient` 内）：控制台用 `_global`

```ts
      const spaceId = chatTargets.get(chatId)?.spaceId ?? "unknown";
      const consoleSession = isConsoleSpace(spaceId);
      const dir = consoleSession
        ? path.join(cfg.agentWorkspaceRoot, "_global")
        : workspaceFor(cfg.agentWorkspaceRoot, spaceId);
```

- `createPiClient` 调用里加：

```ts
        isConsole: consoleSession,
        agentWorkspaceRoot: cfg.agentWorkspaceRoot,
```

- `ensureAgentFiles(dir)` 保持（会给 `_global` 写 AGENTS.md，符合预期）。

> **阶段 1 的引导**：先手工让控制台生效——把 `{"spaceId":"7yl7l4","bootstrappedAt":"2026-10-02T00:00:00Z"}` 写入 `/workspace/console.json`（容器卷内），或设 `CONSOLE_SPACE_ID=7yl7l4`。阶段 2 会自动写。

- [ ] **Step 4: 运行，确认通过 + 全量**

Run: `npx vitest run && npx tsc --noEmit && npm run build`
Expected: 全绿；无类型错误

- [ ] **Step 5: 提交**

```bash
git add src/types.ts src/config.ts src/agent/pi-session.ts src/main.ts test/config.test.ts test/pi-session.test.ts
git commit -m "feat(console): wire console detection and read-only tool set"
```

---

### Task 5: 阶段 1 文档 + 部署

**Files:**
- Modify: `docs/RUNBOOK.md`、`CLAUDE.md`、`README.zh-CN.md`（简述控制台）
- Test: 无（文档）+ 实机冒烟

- [ ] **Step 1: 文档**

在 `RUNBOOK.md` 加一节「控制台（全局助手）」：说明控制台是那个 1:1 空间；阶段 1 用 `CONSOLE_SPACE_ID` 或 `/workspace/console.json` 指定；控制台内可跨空间只读（`anytype_list_spaces` + `space` 参数）、读记忆（`anytype_memories`）；**控制台内无任何写工具**。`CLAUDE.md` 的「Key facts」加一条：控制台会话的工具集是 `CONSOLE_TOOLS`（只读），由 `console.json`/`CONSOLE_SPACE_ID` 选定。

- [ ] **Step 2: 构建 + 部署**

Run:
```bash
npm run build && docker build -t anytype-ai-bot:latest .
cd /home/landspace/anytype && docker compose -f docker-compose.yml -f /home/landspace/anytype-ai-bot/docker-compose.bot.yml up -d --force-recreate --no-deps ai-bot
```

- [ ] **Step 3: 实机冒烟**

在 1:1 控制台里让它 `anytype_list_spaces`，再让它读另一个空间（如「考试」）的某篇；确认能读到，且**没有**写工具（让它试着建页面 → 应失败/无工具）。
```bash
docker logs --tail 30 anytype-ai-bot-1
```

- [ ] **Step 4: 提交**

```bash
git add docs/RUNBOOK.md CLAUDE.md README.zh-CN.md
git commit -m "docs: console (global assistant) — phase 1"
```

---

# 阶段 2（gRPC 桥）

> 阶段 2 引入 `@grpc/grpc-js` + `@grpc/proto-loader`。**只调用已验证的真 handler**（`WorkspaceCreate`、`AppGetVersion`），`SpaceJoin` 字段号**必须先确认**（Step 7.1）。

### Task 6: 链接解析（`src/console/links.ts`）

**Files:**
- Create: `src/console/links.ts`
- Test: `test/console-links.test.ts`

**Interfaces:**
- Produces:
```ts
export type AnytypeLink =
  | { kind: "invite"; cid: string; key: string }
  | { kind: "onetoone"; identity: string; key: string };
export function parseAnytypeLink(raw: string): AnytypeLink | null;
```

- [ ] **Step 1: 写失败测试**

```ts
// test/console-links.test.ts
import { describe, it, expect } from "vitest";
import { parseAnytypeLink } from "../src/console/links.js";

describe("parseAnytypeLink", () => {
  it("parses a 1:1 web link", () => {
    expect(parseAnytypeLink("https://hi.any.coop/AA5HkDmF#CAISIA7GAK")).toEqual({
      kind: "onetoone", identity: "AA5HkDmF", key: "CAISIA7GAK",
    });
  });
  it("parses a 1:1 deeplink", () => {
    expect(parseAnytypeLink("anytype://hi/?id=AA5HkDmF&key=CAISIA7GAK")).toEqual({
      kind: "onetoone", identity: "AA5HkDmF", key: "CAISIA7GAK",
    });
  });
  it("parses an invite deeplink", () => {
    expect(parseAnytypeLink("anytype://invite/?cid=bafyabc&key=zzz")).toEqual({
      kind: "invite", cid: "bafyabc", key: "zzz",
    });
  });
  it("parses an invite web link (non-hi host)", () => {
    expect(parseAnytypeLink("https://example.com/bafyabc#zzz")).toEqual({
      kind: "invite", cid: "bafyabc", key: "zzz",
    });
  });
  it("returns null for junk", () => {
    expect(parseAnytypeLink("hello world")).toBeNull();
    expect(parseAnytypeLink("https://hi.any.coop/onlyid")).toBeNull();
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run test/console-links.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// src/console/links.ts
/**
 * A parsed Anytype link. `invite` joins a shared space; `onetoone` is the 1:1
 * ("hi") link that BOTH sides resolve into the same one-to-one space.
 */
export type AnytypeLink =
  | { kind: "invite"; cid: string; key: string }
  | { kind: "onetoone"; identity: string; key: string };

function q(url: string): URLSearchParams | null {
  const i = url.indexOf("?");
  return i === -1 ? null : new URLSearchParams(url.slice(i + 1).replace(/#.*$/, ""));
}

/** Parse a 1:1 / invite link (deeplink or web form); null if unrecognized. */
export function parseAnytypeLink(raw: string): AnytypeLink | null {
  const s = (raw ?? "").trim();
  if (s.length === 0) return null;

  // anytype://hi/?id=..&key=..  or  anytype://invite/?cid=..&key=..
  if (s.startsWith("anytype://")) {
    const params = q(s);
    if (!params) return null;
    const key = params.get("key") ?? "";
    if (/^anytype:\/\/hi\//i.test(s)) {
      const id = params.get("id") ?? "";
      return id && key ? { kind: "onetoone", identity: id, key } : null;
    }
    if (/^anytype:\/\/invite\//i.test(s)) {
      const cid = params.get("cid") ?? "";
      return cid && key ? { kind: "invite", cid, key } : null;
    }
    return null;
  }

  // https://hi.any.coop/<identity>#<key>   or   https://<host>/<cid>#<key>
  const m = s.match(/^https?:\/\/([^/]+)\/([^#?/]+)#([^#?]+)/);
  if (!m) return null;
  const [, host, a, key] = m;
  if (!a || !key) return null;
  return host.toLowerCase() === "hi.any.coop"
    ? { kind: "onetoone", identity: a, key }
    : { kind: "invite", cid: a, key };
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run test/console-links.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 5: 提交**

```bash
git add src/console/links.ts test/console-links.test.ts
git commit -m "feat(console): parse anytype invite / one-to-one links"
```

---

### Task 7: gRPC 桥（`src/anytype/grpc.ts`）

**Files:**
- Create: `proto/anytype.proto`
- Create: `src/anytype/grpc.ts`
- Modify: `package.json`（依赖 `@grpc/grpc-js`、`@grpc/proto-loader`）
- Modify: `Dockerfile`（`COPY proto ./proto`）
- Test: `test/grpc-token.test.ts`

**Interfaces:**
- Produces:
```ts
export interface HeartGrpcOptions { addr?: string; configPath?: string; protoPath?: string }
export class HeartGrpc {
  constructor(opts?: HeartGrpcOptions);
  appGetVersion(): Promise<string>;
  workspaceCreateOneToOne(identity: string, key: string): Promise<string>; // -> spaceId
  spaceJoin(args: { cid: string; key: string; networkId?: string }): Promise<void>;
}
export function readSessionToken(configPath: string): string | null;
```

- [ ] **Step 1: 确认 `SpaceJoin` 字段号（写代码前必做）**

Run（从本地 CLI 二进制的内嵌 OpenAPI 或 heart 源码取 proto）：
```bash
gh api repos/anyproto/anytype-heart/contents/pb/protos/commands.proto --jq '.content' | base64 -d | grep -A20 "message Join"   # 找 Rpc.Space.Join.Request
```
Expected: 得到 `Rpc.Space.Join.Request` 的字段名与**编号**，据此填写 `proto/anytype.proto` 的 `SpaceJoinRequest`。若取不到，退而求其次：`docker exec anytype-anytype-cli-1 sh -c 'strings /usr/local/bin/anytype | grep -A2 -i "inviteCid"'`。**字段号未确认前不要实现 `spaceJoin`**（可先只做 `WorkspaceCreate`/`AppGetVersion`）。

- [ ] **Step 2: 写失败测试**（token 读取）

```ts
// test/grpc-token.test.ts
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSessionToken } from "../src/anytype/grpc.js";

describe("readSessionToken", () => {
  it("reads sessionToken from a CLI config.json", () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cfg-")), "config.json");
    fs.writeFileSync(f, JSON.stringify({ sessionToken: "tok123", accountKey: "ak" }));
    expect(readSessionToken(f)).toBe("tok123");
  });
  it("returns null when missing/unreadable/malformed", () => {
    expect(readSessionToken("/nope/not-here.json")).toBeNull();
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cfg-")), "config.json");
    fs.writeFileSync(f, "{bad");
    expect(readSessionToken(f)).toBeNull();
  });
});
```

- [ ] **Step 3: 运行，确认失败**

Run: `npx vitest run test/grpc-token.test.ts`
Expected: FAIL

- [ ] **Step 4: 安装依赖 + proto + 实现**

```bash
npm i @grpc/grpc-js @grpc/proto-loader
```

`proto/anytype.proto`（字段号：`WorkspaceCreate` 已实测；`SpaceJoin` 用 Step 1 确认的值）：

```proto
syntax = "proto3";
package anytype;
import "google/protobuf/struct.proto";

service ClientCommands {
  rpc AppGetVersion (AppGetVersionRequest) returns (AppGetVersionResponse);
  rpc WorkspaceCreate (WorkspaceCreateRequest) returns (WorkspaceCreateResponse);
  rpc SpaceJoin (SpaceJoinRequest) returns (SpaceJoinResponse);
}

message Error { int32 code = 1; string description = 2; }

message AppGetVersionRequest {}
message AppGetVersionResponse { Error error = 1; string version = 2; }

message WorkspaceCreateRequest {
  google.protobuf.Struct details = 1; // {oneToOneIdentity, oneToOneRequestMetadataKey, spaceType:4, spaceAccessType:2}
  int32 useCase = 2;                  // 1 = CHAT_SPACE
}
message WorkspaceCreateResponse { Error error = 1; string spaceId = 2; }

// Field numbers VERIFIED against anytype-heart pb/protos/commands.proto:
//   Rpc.Space.Join.Request { networkId=1; spaceId=2; inviteCid=3; inviteFileKey=4; }
message SpaceJoinRequest { string networkId = 1; string spaceId = 2; string inviteCid = 3; string inviteFileKey = 4; }
message SpaceJoinResponse { Error error = 1; }
```

`src/anytype/grpc.ts`：

```ts
import fs from "node:fs";
import path from "node:path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

export interface HeartGrpcOptions {
  /** anytype-heart gRPC address. Default 127.0.0.1:31010. */
  addr?: string;
  /** anytype-cli config.json holding the session token. */
  configPath?: string;
  /** Path to proto/anytype.proto. */
  protoPath?: string;
}

/** Read `sessionToken` from an anytype-cli config.json; null when absent/unreadable. */
export function readSessionToken(configPath: string): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as { sessionToken?: unknown };
    return typeof raw.sessionToken === "string" && raw.sessionToken.length > 0 ? raw.sessionToken : null;
  } catch {
    return null;
  }
}

const DEFAULT_ADDR = "127.0.0.1:31010";
const DEFAULT_CONFIG = "/root/.anytype/config.json";

/**
 * Minimal client for anytype-heart's local gRPC (ClientCommands). Plaintext
 * h2c + a `token` metadata header. The token is re-read on demand, so a
 * restarted anytype-cli (which mints a new session token) is picked up.
 *
 * Only call methods that are real handlers — some RPCs are removed stubs that
 * PANIC the CLI process (e.g. WorkspaceGetAll).
 */
export class HeartGrpc {
  private readonly addr: string;
  private readonly configPath: string;
  private readonly protoPath: string;
  private pkg?: Record<string, any>;
  private client?: grpc.Client;

  constructor(opts: HeartGrpcOptions = {}) {
    this.addr = opts.addr ?? process.env.GRPC_ADDR ?? DEFAULT_ADDR;
    this.configPath = opts.configPath ?? process.env.ANYTYPE_CLI_CONFIG ?? DEFAULT_CONFIG;
    this.protoPath = opts.protoPath ?? process.env.ANYTYPE_PROTO ?? path.resolve(process.cwd(), "proto/anytype.proto");
  }

  private load(): Record<string, any> {
    if (this.pkg) return this.pkg;
    const def = protoLoader.loadSync(this.protoPath, {
      keepCase: false,
      longs: String,
      enums: Number,
      defaults: true,
      oneofs: true,
    });
    const desc = grpc.loadPackageDefinition(def) as any;
    this.pkg = desc.anytype;
    return this.pkg;
  }

  private getClient(): grpc.Client {
    if (this.client) return this.client;
    const pkg = this.load();
    this.client = new pkg.ClientCommands(this.addr, grpc.credentials.createInsecure());
    return this.client;
  }

  private metadata(): grpc.Metadata {
    const token = readSessionToken(this.configPath);
    const md = new grpc.Metadata();
    if (token) md.set("token", token);
    return md;
  }

  private call(method: string, request: unknown): Promise<any> {
    const client = this.getClient() as any;
    return new Promise((resolve, reject) => {
      client[method](request, this.metadata(), { deadline: Date.now() + 15000 }, (err: any, res: any) => {
        if (err) reject(err);
        else resolve(res ?? {});
      });
    });
  }

  private errText(res: any): string | null {
    const e = res?.error;
    if (!e) return null;
    const code = e.code ?? "?";
    const desc = e.description ?? "";
    return code === 0 || code === "0" ? null : `code ${code}: ${desc}`;
  }

  async appGetVersion(): Promise<string> {
    const res = await this.call("AppGetVersion", {});
    const e = this.errText(res);
    if (e) throw new Error(e);
    return String(res.version ?? "");
  }

  /** Mirror a one-to-one space from (identity, key). Returns the new space id. */
  async workspaceCreateOneToOne(identity: string, key: string): Promise<string> {
    const res = await this.call("WorkspaceCreate", {
      details: { oneToOneIdentity: identity, oneToOneRequestMetadataKey: key, spaceType: 4, spaceAccessType: 2 },
      useCase: 1,
    });
    const e = this.errText(res);
    if (e) throw new Error(e);
    if (!res.spaceId) throw new Error("WorkspaceCreate returned no spaceId");
    return String(res.spaceId);
  }

  /** Join a shared space from an invite link's cid/key. */
  async spaceJoin(args: { cid: string; key: string; networkId?: string }): Promise<void> {
    const res = await this.call("SpaceJoin", {
      inviteCid: args.cid,
      inviteFileKey: args.key,
      ...(args.networkId ? { networkId: args.networkId } : {}),
    });
    const e = this.errText(res);
    if (e) throw new Error(e);
  }
}
```

`Dockerfile`：在 COPY 源码之后加 `COPY proto ./proto`（确保镜像内 `/app/proto/anytype.proto` 存在，`process.cwd()` = `/app`）。

- [ ] **Step 5: 运行，确认通过**

Run: `npx vitest run test/grpc-token.test.ts && npx tsc --noEmit`
Expected: PASS（2 tests），无类型错误

- [ ] **Step 6: 提交**

```bash
git add package.json package-lock.json proto/anytype.proto src/anytype/grpc.ts test/grpc-token.test.ts Dockerfile
git commit -m "feat(grpc): minimal anytype-heart gRPC client (workspaceCreate, spaceJoin)"
```

---

### Task 8: 引导（`src/console/bootstrap.ts`）

**Files:**
- Create: `src/console/bootstrap.ts`
- Test: `test/console-bootstrap.test.ts`

**Interfaces:**
- Consumes: `HeartGrpc`（Task 7）、`parseAnytypeLink`（Task 6）、`writeConsole`（Task 1）
- Produces:
```ts
export function botOneToOneLink(identity: string, key: string): string;      // anytype://hi/?id=..&key=..
export function newRequestKey(): string;                                     // random URL-safe key
export async function bootstrapFromLink(
  g: HeartGrpc, link: string, consoleFile: string,
): Promise<{ ok: true; spaceId: string; kind: "invite" | "onetoone" } | { ok: false; error: string }>;
```

- [ ] **Step 1: 写失败测试**

```ts
// test/console-bootstrap.test.ts
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bootstrapFromLink, botOneToOneLink } from "../src/console/bootstrap.js";
import { readConsole } from "../src/console/console-store.js";

function tmpConsole(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "console-")), "console.json");
}

describe("botOneToOneLink", () => {
  it("builds the deeplink form", () => {
    expect(botOneToOneLink("BOTID", "KEY1")).toBe("anytype://hi/?id=BOTID&key=KEY1");
  });
});

describe("bootstrapFromLink", () => {
  it("mirrors a 1:1 link and records the console", async () => {
    const g = { workspaceCreateOneToOne: vi.fn(async () => "spNEW") } as any;
    const f = tmpConsole();
    const r = await bootstrapFromLink(g, "https://hi.any.coop/USERID#KEYX", f);
    expect(r).toEqual({ ok: true, spaceId: "spNEW", kind: "onetoone" });
    expect(g.workspaceCreateOneToOne).toHaveBeenCalledWith("USERID", "KEYX");
    expect(readConsole(f)?.spaceId).toBe("spNEW");
  });

  it("joins an invite link (no console written)", async () => {
    const g = { spaceJoin: vi.fn(async () => {}) } as any;
    const f = tmpConsole();
    const r = await bootstrapFromLink(g, "anytype://invite/?cid=C1&key=K1", f);
    expect(r).toEqual({ ok: true, spaceId: "", kind: "invite" });
    expect(g.spaceJoin).toHaveBeenCalledWith({ cid: "C1", key: "K1" });
    expect(readConsole(f)).toBeNull();
  });

  it("reports an error for junk input", async () => {
    const r = await bootstrapFromLink({} as any, "not a link", tmpConsole());
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run test/console-bootstrap.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// src/console/bootstrap.ts
import crypto from "node:crypto";
import type { HeartGrpc } from "../anytype/grpc.js";
import { parseAnytypeLink } from "./links.js";
import { writeConsole } from "./console-store.js";

/** The bot's own shareable 1:1 link (user opens it → one-to-one with the bot). */
export function botOneToOneLink(identity: string, key: string): string {
  return `anytype://hi/?id=${identity}&key=${key}`;
}

/** A fresh random request key (base64url, ~32 bytes). */
export function newRequestKey(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * Act on a link the user shared:
 *  - `onetoone` → mirror the space (WorkspaceCreate) and RECORD it as the console.
 *  - `invite`   → join the shared space (SpaceJoin); nothing recorded.
 * Never throws; returns a discriminated result.
 */
export async function bootstrapFromLink(
  g: HeartGrpc,
  link: string,
  consoleFile: string,
): Promise<{ ok: true; spaceId: string; kind: "invite" | "onetoone" } | { ok: false; error: string }> {
  const parsed = parseAnytypeLink(link);
  if (!parsed) return { ok: false, error: "无法识别的链接（既不是邀请链接也不是 1:1 链接）" };
  try {
    if (parsed.kind === "onetoone") {
      const spaceId = await g.workspaceCreateOneToOne(parsed.identity, parsed.key);
      writeConsole(consoleFile, { spaceId, bootstrappedAt: new Date().toISOString() });
      return { ok: true, spaceId, kind: "onetoone" };
    }
    await g.spaceJoin({ cid: parsed.cid, key: parsed.key });
    return { ok: true, spaceId: "", kind: "invite" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run test/console-bootstrap.test.ts && npx tsc --noEmit`
Expected: PASS（4 tests）

- [ ] **Step 5: 提交**

```bash
git add src/console/bootstrap.ts test/console-bootstrap.test.ts
git commit -m "feat(console): bootstrap (mirror one-to-one / join invite / bot link)"
```

---

### Task 9: `/join` 指令 + `anytype_join_space` 工具 + 启动打印链接

**Files:**
- Modify: `src/commands/handler.ts`（`/join <link>`；`CommandContext.joinSpace`）
- Modify: `src/main.ts`（接线 `joinSpace`；启动时若无控制台则打印 bot 链接）
- Modify: `src/agent/anytype-tools.ts`（`anytype_join_space` 工具，仅 console）
- Test: `test/commands-handler.test.ts`（追加）、`test/console-tools.test.ts`（追加）

**Interfaces:**
- Consumes: `bootstrapFromLink`（Task 8）、`HeartGrpc`（Task 7）
- Produces:
  - `CommandContext.joinSpace(link: string): Promise<{ ok: boolean; message: string }>`
  - deps 新增 `console?.joinSpace?: (link: string) => Promise<{ok:boolean;message:string}>`（供工具用）

- [ ] **Step 1: 写失败测试**

handler（追加）：

```ts
it("/join delegates to ctx.joinSpace and echoes the result", async () => {
  const c = fakeClient();
  const { context } = ctx(c);
  const joinSpace = vi.fn(async () => ({ ok: true, message: "已加入空间 spNEW" }));
  const reply = await handleCommand("join", "https://hi.any.coop/X#Y", { ...context, joinSpace });
  expect(joinSpace).toHaveBeenCalledWith("https://hi.any.coop/X#Y");
  expect(reply).toContain("已加入空间");
});
it("/join with no arg shows usage", async () => {
  const { context } = ctx(fakeClient());
  const reply = await handleCommand("join", "", { ...context, joinSpace: vi.fn() });
  expect(reply).toMatch(/用法/);
});
```

tools（追加）：

```ts
it("anytype_join_space is only in console sessions", async () => {
  expect(toolNames(createAnytypeTools(baseDeps(fakeApi())))).not.toContain("anytype_join_space");
  const joinSpace = vi.fn(async () => ({ ok: true, message: "joined" }));
  const deps = { ...baseDeps(fakeApi(), false), console: { workspaceRoot: "/tmp/ws", joinSpace } };
  const tools = createAnytypeTools(deps);
  const t = tools.find((x) => x.name === "anytype_join_space")!;
  const text = ((await t.execute("id", { link: "https://hi.any.coop/X#Y" })).content[0] as { text: string }).text;
  expect(joinSpace).toHaveBeenCalledWith("https://hi.any.coop/X#Y");
  expect(text).toContain("joined");
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run test/commands-handler.test.ts test/console-tools.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

3a. `src/commands/handler.ts`：
- `CommandContext` 加 `joinSpace(link: string): Promise<{ ok: boolean; message: string }>;`（必填，main 会提供）
- `HELP_TEXT` 加一行 `/join <链接> — 加入一个空间（邀请链接）或接入 1:1 控制台（1:1 链接）`
- 新增 case：

```ts
    case "join": {
      if (!args) return "用法：/join <链接>（邀请链接，或 1:1 链接以接入控制台）";
      const r = await ctx.joinSpace(args);
      return r.message;
    }
```

3b. `src/agent/anytype-tools.ts`：
- deps 的 `console` 类型扩展为 `{ workspaceRoot: string; joinSpace?: (link: string) => Promise<{ok:boolean;message:string}> }`
- 新增工具（在 `memories` 之后）：

```ts
  const joinSpace = defineTool({
    name: "anytype_join_space",
    label: "Join a space",
    description:
      "Join a space from a link the user shared. An INVITE link adds the assistant to that shared space; a 1:1 (hi.any.coop) link connects the assistant to the user's one-to-one console. Only call this when the user clearly asks to join / connect using a link they provided.",
    promptSnippet: "anytype_join_space — join a space or connect the 1:1 console from a link",
    promptGuidelines: GUIDELINES,
    parameters: Type.Object({
      link: Type.String({ description: "The invite or 1:1 link to act on." }),
    }),
    async execute(_id, params) {
      if (!consoleDep?.joinSpace) return textResult("anytype_join_space unavailable in this session.");
      try {
        const r = await consoleDep.joinSpace(params.link);
        return textResult(r.message);
      } catch (err) {
        return textResult(`anytype_join_space failed: ${errMessage(err)}`);
      }
    },
  });
```

- 组装：`if (consoleDep) tools.push(listSpaces, memories, joinSpace);`

3c. `src/main.ts`：
- 构造 `HeartGrpc`（惰性；仅当需要时）：

```ts
  const grpcClient = new HeartGrpc({});
  const consoleFile = path.join(cfg.agentWorkspaceRoot, "console.json");
  const joinSpace = async (link: string): Promise<{ ok: boolean; message: string }> => {
    if (!cfg.consoleSpaceId) {
      const r = await bootstrapFromLink(grpcClient, link, consoleFile);
      if (!r.ok) return { ok: false, message: `接入失败：${r.error}` };
      if (r.kind === "onetoone") {
        return {
          ok: true,
          message: `已接入控制台（空间 ${r.spaceId}）。重启后生效：docker compose ... up -d --force-recreate --no-deps ai-bot`,
        };
      }
      return { ok: true, message: `已加入空间（邀请链接）` };
    }
    const r = await bootstrapFromLink(grpcClient, link, consoleFile);
    return { ok: r.ok, message: r.ok ? "已完成" : `失败：${r.error}` };
  };
```

- `CommandContext` 组装处加 `joinSpace,`
- 控制台会话的 `createClient` 里，把 `joinSpace` 塞进 `console` dep：

```ts
        ...(consoleSession ? { console: { workspaceRoot: cfg.agentWorkspaceRoot, joinSpace } } : {}),
```

（`createPiClient` 的 `console` dep 需一并透传；在 `PiClientOptions` 加 `console?: { workspaceRoot: string; joinSpace?: (link:string)=>Promise<{ok:boolean;message:string}> }`，并在顶层 `createAnytypeTools` 调用里 `...(opts.console ? { console: opts.console } : {})`。）

- 启动时若无控制台，打印 bot 链接（模式 A，best-effort）：

```ts
  if (!consoleSpaceId) {
    const botId = cfg.botIdentity ?? "(bot identity unknown)";
    const link = botOneToOneLink(botId, newRequestKey());
    console.log(
      `\n=== 控制台未设置 ===\n把你的 1:1 链接发给 bot（或运行 /join <链接>）即可接入控制台。\n` +
      `（bot 侧链接，打开后可能仍需把你自己链接回贴一次：${link}）\n`,
    );
  }
```

- 导入：`import { HeartGrpc } from "./anytype/grpc.js"; import { bootstrapFromLink, botOneToOneLink, newRequestKey } from "./console/bootstrap.js";`

- [ ] **Step 4: 运行，确认通过 + 全量**

Run: `npx vitest run && npx tsc --noEmit && npm run build`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add src/commands/handler.ts src/agent/anytype-tools.ts src/agent/pi-session.ts src/main.ts test/commands-handler.test.ts test/console-tools.test.ts
git commit -m "feat(console): /join command, anytype_join_space, boot-time console link"
```

---

### Task 10: 阶段 2 实机验证 + 文档

**Files:**
- Modify: `docs/RUNBOOK.md`、`CLAUDE.md`
- Test: 实机（无单测）

- [ ] **Step 1: 构建 + 部署**

Run:
```bash
npm run build && docker build -t anytype-ai-bot:latest .
cd /home/landspace/anytype && docker compose -f docker-compose.yml -f /home/landspace/anytype-ai-bot/docker-compose.bot.yml up -d --force-recreate --no-deps ai-bot
docker logs --tail 30 anytype-ai-bot-1
```
Expected: 镜像构建成功；日志出现「控制台未设置」提示（或已有控制台）。

- [ ] **Step 2: 实机冒烟（两种模式）**

- **B（保证可用）**：在 1:1 里发 `/join https://hi.any.coop/<你的identity>#<key>` → 期望回「已接入控制台（空间 …）」；`docker logs` 里 `discovery` 变多一个空间。
- **A（best-effort）**：按启动日志提示操作；若 inbox 没送达，会退化为 B（把链接发给它）。
- **加入邀请**：发一个**别的**空间的邀请链接 → 期望「已加入空间」，且日志里出现该空间订阅。

- [ ] **Step 3: 文档**

`RUNBOOK.md` 更新：`/join` 用法、两种引导模式、`SpaceJoin`/`WorkspaceCreate` 的注意（**别碰 stub 方法**：会 panic 打死 cli；如此需 `up -d --force-recreate --no-deps ai-bot` 重建 bot 以恢复 netns）。`CLAUDE.md` 加一节 gRPC 桥（`src/anytype/grpc.ts`、`proto/anytype.proto`、只用真 handler）。

- [ ] **Step 4: 提交**

```bash
git add docs/RUNBOOK.md CLAUDE.md
git commit -m "docs: console phase 2 (gRPC bridge, /join)"
```

---

## 自检记录

- **Spec 覆盖**：§3 识别/引导 → Task 1/4/8/9；§4 跨空间只读 → Task 2；§5 memory → Task 3；§6 接受链接 → Task 6/7/8/9；§7 组件 → 各 Task 的 Files；§9 测试 → 各 Task 的测试步骤 + Task 5/10 实机；§10 阶段 → 阶段 1=T1–5，阶段 2=T6–10。
- **类型一致**：`ConsoleRecord`、`parseAnytypeLink`、`HeartGrpc`、`bootstrapFromLink`、`CONSOLE_TOOLS`、`console` dep（`{workspaceRoot, joinSpace?}`）在各 Task 之间名称一致。
- **风险**：Task 7 Step 1 是**硬性前置**（`SpaceJoin` 字段号未确认前不得实现 `spaceJoin`）；Task 9 的配置透传较琐碎，执行时对照 `pi-session.ts` 现有 `createAnytypeTools` 两处调用逐一补 `console`。
