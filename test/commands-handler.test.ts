import { describe, it, expect, vi } from "vitest";
import { handleCommand, HELP_TEXT, type CommandContext } from "../src/commands/handler.js";
import type { ManagedClient } from "../src/session/manager.js";

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
    setThinkingLevel: vi.fn((level: string) => (level === "max" ? "xhigh" : level)),
    getThinkingLevel: vi.fn(() => "medium"),
    setAutoTools: vi.fn((enabled: boolean) => (enabled ? "YOLO 自动模式：开" : "YOLO 自动模式：关")),
    isAutoTools: vi.fn(() => true),
    ...overrides,
  };
  return client;
}

function ctx(client: ManagedClient | undefined) {
  const ensure = vi.fn(async () => client ?? fakeClient());
  const reset = vi.fn(async () => {});
  const context: CommandContext = {
    chatId: "c1",
    getClient: () => client,
    ensureClient: ensure,
    reset,
    defaultModel: "deepseek-flash",
  };
  return { context, ensure, reset };
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

  it("/model with no arg reports the current model", async () => {
    const c = fakeClient();
    const { context, ensure } = ctx(c);
    const reply = await handleCommand("model", "", context);
    expect(reply).toContain("deepseek-flash");
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
  });

  it("/effort with no arg reports the current level", async () => {
    const c = fakeClient();
    const { context } = ctx(c);
    const reply = await handleCommand("effort", "", context);
    expect(reply).toContain("medium");
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

  it("/effort bogus is rejected without touching the client", async () => {
    const c = fakeClient();
    const { context, ensure } = ctx(c);
    const reply = await handleCommand("effort", "bogus", context);
    expect(ensure).not.toHaveBeenCalled();
    expect(reply).toMatch(/无效/);
  });

  it("/yolo with no arg reports the current state (default on)", async () => {
    const c = fakeClient();
    const { context } = ctx(c);
    const reply = await handleCommand("yolo", "", context);
    expect(reply).toMatch(/开/);
  });

  it("/yolo off toggles auto tools off", async () => {
    const c = fakeClient();
    const { context } = ctx(c);
    const reply = await handleCommand("yolo", "off", context);
    expect(c.setAutoTools).toHaveBeenCalledWith(false);
    expect(reply).toContain("关");
  });

  it("/yolo on toggles auto tools on", async () => {
    const c = fakeClient();
    const { context } = ctx(c);
    const reply = await handleCommand("yolo", "on", context);
    expect(c.setAutoTools).toHaveBeenCalledWith(true);
    expect(reply).toContain("开");
  });

  it("/help lists the commands", async () => {
    const { context } = ctx(fakeClient());
    const reply = await handleCommand("help", "", context);
    expect(reply).toBe(HELP_TEXT);
    for (const c of ["/new", "/clear", "/compact", "/model", "/effort", "/yolo", "/help"]) {
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
    await expect(handleCommand("yolo", "", context)).resolves.toMatch(/开/);
  });
});
