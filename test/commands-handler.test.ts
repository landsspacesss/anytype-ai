import { describe, it, expect, vi } from "vitest";
import { handleCommand, HELP_TEXT, type CommandContext } from "../src/commands/handler.js";
import type { InterruptPolicy, ManagedClient } from "../src/session/manager.js";
import type { ApprovalMode } from "../src/agent/approval.js";

/** A fake ManagedClient whose control ops are spies; prompt/close/abort are no-ops. */
function fakeClient(overrides: Partial<ManagedClient> = {}) {
  const client: ManagedClient = {
    busy: false,
    prompt: vi.fn(async () => "ok"),
    close: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    reset: vi.fn(async () => {}),
    compact: vi.fn(async () => "已压缩（压缩前 123 tokens）"),
    setModel: vi.fn(async (id: string) => (id === "nope" ? null : id)),
    getModel: vi.fn(() => "deepseek-flash"),
    getAvailableModels: vi.fn(() => ["deepseek/deepseek-flash", "deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro"]),
    setThinkingLevel: vi.fn((level: string) => (level === "max" ? "xhigh" : level)),
    getThinkingLevel: vi.fn(() => "medium"),
    // Mirror DeepSeek V4: only off/high/max exist.
    getAvailableThinkingLevels: vi.fn(() => ["off", "high", "max"]),
    setAutoTools: vi.fn((enabled: boolean) => (enabled ? "YOLO 自动模式：开" : "YOLO 自动模式：关")),
    isAutoTools: vi.fn(() => true),
    ...overrides,
  };
  return client;
}

function ctx(client: ManagedClient | undefined, policy: InterruptPolicy = "step") {
  const ensure = vi.fn(async () => client ?? fakeClient());
  const reset = vi.fn(async () => {});
  let current: InterruptPolicy = policy;
  const setInterruptPolicy = vi.fn(async (p: InterruptPolicy) => {
    current = p;
    return p;
  });
  const joinSpace = vi.fn(async () => ({ ok: true, message: "ok" }));
  const runWorkflow = vi.fn(async () => ({ ok: true, message: "started r1" }));
  const listRuns = vi.fn(() => [{ id: "r1", name: "demo", status: "done", when: "t" }]);
  let mode: ApprovalMode = "auto";
  const setApprovalMode = vi.fn((m: ApprovalMode) => { mode = m; return m; });
  const approvePending = vi.fn(() => true);
  const getApprovalMode = () => mode;
  let unlocked = false;
  const getConsoleUnlocked = () => unlocked;
  const setConsoleUnlocked = vi.fn((on: boolean) => { unlocked = on; return on; });
  const context: CommandContext = {
    chatId: "c1",
    getClient: () => client,
    ensureClient: ensure,
    reset,
    defaultModel: "deepseek-flash",
    getInterruptPolicy: () => current,
    setInterruptPolicy,
    joinSpace,
    runWorkflow,
    listRuns,
    getApprovalMode,
    setApprovalMode,
    approvePending,
    isConsole: false,
    getConsoleUnlocked,
    setConsoleUnlocked,
  };
  return {
    context,
    ensure,
    reset,
    setInterruptPolicy,
    joinSpace,
    runWorkflow,
    listRuns,
    setApprovalMode,
    approvePending,
    getPolicy: () => current,
    getApprovalMode,
    setConsoleUnlocked,
  };
}

describe("handleCommand", () => {
  it("/new resets the session", async () => {
    const c = fakeClient();
    const { context, reset } = ctx(c);
    const reply = await handleCommand("new", "", context);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(reply).toMatch(/新/);
  });

  it("/clear is an alias of /new", async () => {
    const c = fakeClient();
    const { context, reset } = ctx(c);
    const reply = await handleCommand("clear", "", context);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(reply).toMatch(/新/);
  });

  it("/compact calls client.compact and reports a status", async () => {
    const c = fakeClient();
    const { context } = ctx(c);
    const reply = await handleCommand("compact", "", context);
    expect(c.compact).toHaveBeenCalledTimes(1);
    expect(reply).toContain("已压缩当前对话");
  });

  it("/model with no arg reports the current model AND the usable model list", async () => {
    const c = fakeClient();
    const { context, ensure } = ctx(c);
    const reply = await handleCommand("model", "", context);
    expect(reply).toContain("deepseek-flash");
    expect(reply).toContain("可用模型");
    expect(reply).toContain("deepseek: deepseek-flash, deepseek-v4-flash, deepseek-v4-pro");
    expect(ensure).not.toHaveBeenCalled();
  });

  it("/model <name> switches via the client", async () => {
    const c = fakeClient();
    const { context } = ctx(c);
    const reply = await handleCommand("model", "deepseek-v4-pro", context);
    expect(c.setModel).toHaveBeenCalledWith("deepseek-v4-pro");
    expect(reply).toContain("deepseek-v4-pro");
  });

  it("/model <unknown> reports unknown and leaves model unchanged", async () => {
    const c = fakeClient();
    const { context } = ctx(c);
    const reply = await handleCommand("model", "nope", context);
    expect(c.setModel).toHaveBeenCalledWith("nope");
    expect(reply).toMatch(/未知模型/);
    expect(reply).toContain("可用模型"); // unknown → suggest the real ids
  });

  it("/effort with no arg reports the current level and the model's levels", async () => {
    const c = fakeClient();
    const { context } = ctx(c);
    const reply = await handleCommand("effort", "", context);
    expect(reply).toContain("medium");
    expect(reply).toContain("off|high|max");
  });

  it("/effort high sets the thinking level", async () => {
    const c = fakeClient();
    const { context } = ctx(c);
    const reply = await handleCommand("effort", "high", context);
    expect(c.setThinkingLevel).toHaveBeenCalledWith("high");
    expect(reply).toContain("high");
  });

  it("/effort max maps through the client", async () => {
    const c = fakeClient();
    const { context } = ctx(c);
    const reply = await handleCommand("effort", "max", context);
    expect(c.setThinkingLevel).toHaveBeenCalledWith("max");
    expect(reply).toContain("xhigh");
  });

  it("/effort rejects a level the model does not support, without touching the client", async () => {
    const c = fakeClient();
    const { context, ensure } = ctx(c);
    const reply = await handleCommand("effort", "low", context);
    expect(ensure).not.toHaveBeenCalled();
    expect(c.setThinkingLevel).not.toHaveBeenCalled();
    expect(reply).toMatch(/不支持/);
    expect(reply).toContain("off|high|max");
  });

  it("/effort bogus is rejected without touching the client", async () => {
    const c = fakeClient();
    const { context, ensure } = ctx(c);
    const reply = await handleCommand("effort", "bogus", context);
    expect(ensure).not.toHaveBeenCalled();
    expect(reply).toMatch(/不支持/);
  });

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

  it("/yolo is inert in the console", async () => {
    const c = fakeClient();
    const { context, setApprovalMode } = ctx(c);
    const reply = await handleCommand("yolo", "ask", { ...context, isConsole: true });
    expect(setApprovalMode).not.toHaveBeenCalled();
    expect(reply).toMatch(/控制台/);
  });

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

  it("/interrupt with no arg reports the current policy (default step)", async () => {
    const { context, setInterruptPolicy } = ctx(fakeClient());
    const reply = await handleCommand("interrupt", "", context);
    expect(reply).toContain("等这一步结束");
    expect(setInterruptPolicy).not.toHaveBeenCalled();
  });

  it("/interrupt now sets the immediate policy", async () => {
    const { context, setInterruptPolicy, getPolicy } = ctx(fakeClient());
    const reply = await handleCommand("interrupt", "now", context);
    expect(setInterruptPolicy).toHaveBeenCalledWith("immediate");
    expect(getPolicy()).toBe("immediate");
    expect(reply).toContain("立刻打断");
  });

  it("/interrupt step switches back from immediate", async () => {
    const { context, setInterruptPolicy, getPolicy } = ctx(fakeClient(), "immediate");
    const reply = await handleCommand("interrupt", "step", context);
    expect(setInterruptPolicy).toHaveBeenCalledWith("step");
    expect(getPolicy()).toBe("step");
    expect(reply).toContain("等这一步结束");
  });

  it("/interrupt bogus is rejected without changing the policy", async () => {
    const { context, setInterruptPolicy } = ctx(fakeClient());
    const reply = await handleCommand("interrupt", "bogus", context);
    expect(setInterruptPolicy).not.toHaveBeenCalled();
    expect(reply).toMatch(/用法/);
  });

  it("/help lists the commands", async () => {
    const { context } = ctx(fakeClient());
    const reply = await handleCommand("help", "", context);
    expect(reply).toBe(HELP_TEXT);
    for (const c of ["/new", "/clear", "/compact", "/model", "/effort", "/yolo", "/interrupt", "/help"]) {
      expect(reply).toContain(c);
    }
  });

  it("unknown command returns a hint", async () => {
    const { context } = ctx(fakeClient());
    const reply = await handleCommand("xyz", "", context);
    expect(reply).toContain("未知指令：/xyz");
  });

  it("works when no client exists for read-only commands", async () => {
    const { context } = ctx(undefined);
    await expect(handleCommand("model", "", context)).resolves.toContain("deepseek-flash");
    await expect(handleCommand("yolo", "", context)).resolves.toMatch(/auto/);
  });

  it("/interrupt works with no live client (read + write)", async () => {
    const { context, getPolicy } = ctx(undefined);
    await expect(handleCommand("interrupt", "", context)).resolves.toContain("打断策略");
    await expect(handleCommand("interrupt", "now", context)).resolves.toContain("立刻打断");
    expect(getPolicy()).toBe("immediate");
  });

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
});
