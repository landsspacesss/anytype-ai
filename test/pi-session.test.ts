import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createPiClient,
  decideInterrupt,
  ensureAgentFiles,
  isInterruptibleTool,
  type PiClientOptions,
} from "../src/agent/pi-session.js";
import { CONSOLE_TOOLS, effectiveToolNames, buildSessionResourceLoader, TextSegmenter } from "../src/agent/pi-session.js";
import type { ManagedClient } from "../src/session/manager.js";

// Type-only guarantee that createPiClient is a ManagedClient factory. This is
// checked by tsc; it runs for free at test time because the module is imported.
const _shapeCheck: (opts: PiClientOptions) => Promise<ManagedClient> = createPiClient;
void _shapeCheck;

describe("createPiClient (shape)", () => {
  // We deliberately do NOT construct a real session here: createAgentSession
  // resolves a model and would need a provider key, which must not be required
  // in CI. See .superpowers/sdd/task-15-report.md for the in-container smoke
  // test that exercises the real SDK end-to-end.
  it("is exported as a factory function", () => {
    expect(typeof createPiClient).toBe("function");
  });
});

describe("interrupt decisions", () => {
  it("classifies only pure-read tools as interruptible", () => {
    expect(isInterruptibleTool("anytype_read_object")).toBe(true);
    expect(isInterruptibleTool("anytype_list_objects")).toBe(true);
    expect(isInterruptibleTool("read")).toBe(true);
    // Anything that writes (or is unknown) must not be cut mid-flight.
    expect(isInterruptibleTool("anytype_create_note")).toBe(false);
    expect(isInterruptibleTool("anytype_set_property")).toBe(false);
    expect(isInterruptibleTool("bash")).toBe(false);
    expect(isInterruptibleTool("brand_new_tool")).toBe(false);
  });

  it("immediate always aborts now", () => {
    expect(decideInterrupt("immediate", null)).toBe("abort-now");
    expect(
      decideInterrupt("immediate", { name: "anytype_create_note", interruptible: false }),
    ).toBe("abort-now");
    expect(decideInterrupt("immediate", { name: "read", interruptible: true })).toBe("abort-now");
  });

  it("step aborts now while thinking or reading", () => {
    expect(decideInterrupt("step", null)).toBe("abort-now");
    expect(decideInterrupt("step", { name: "anytype_search", interruptible: true })).toBe("abort-now");
  });

  it("step waits for an in-flight write tool to finish", () => {
    expect(
      decideInterrupt("step", { name: "anytype_create_note", interruptible: false }),
    ).toBe("after-tool");
  });
});

describe("ensureAgentFiles", () => {
  it("writes AGENTS.md referencing MEMORY.md into a fresh workspace dir", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ws-"));
    ensureAgentFiles(dir);
    const agentsMd = path.join(dir, "AGENTS.md");
    expect(fs.existsSync(agentsMd)).toBe(true);
    const body = fs.readFileSync(agentsMd, "utf-8");
    expect(body).toContain("MEMORY.md");
    expect(body).toContain("# Memory");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not clobber an existing AGENTS.md", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ws-"));
    const agentsMd = path.join(dir, "AGENTS.md");
    fs.writeFileSync(agentsMd, "custom-existing-content", "utf-8");
    ensureAgentFiles(dir);
    expect(fs.readFileSync(agentsMd, "utf-8")).toBe("custom-existing-content");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

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

  it("includes every console-only tool that createAnytypeTools registers under the console dep", () => {
    // These are the tools registered ONLY when the `console` dep is present;
    // if one is missing here, applyTools() silently strips it in a console session.
    for (const t of ["anytype_list_spaces", "anytype_memories", "anytype_join_space"]) {
      expect(CONSOLE_TOOLS).toContain(t);
    }
  });
});

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

describe("buildSessionResourceLoader (approval gate wiring)", () => {
  // Regression guard for the REAL production builder: the SDK uses a
  // caller-supplied loader AS-IS (it only auto-reloads a loader it builds
  // itself), so buildSessionResourceLoader must `await reload()`. Deleting that
  // reload empties getExtensions() and makes this test fail — which is exactly
  // the bug we shipped once.
  it("reloads so the inline extension (and its tool_call hook) register", async () => {
    const loader = await buildSessionResourceLoader({
      cwd: process.cwd(),
      extensionFactories: [(pi) => { pi.on("tool_call", () => undefined); }],
    });
    // Identify OUR inline factory by its synthetic path (disk extensions have
    // real file paths); this makes the assertion independent of whatever
    // extensions happen to exist on the host.
    const inline = loader.getExtensions().extensions.find((e) => e.path.startsWith("<inline:"));
    expect(inline).toBeDefined();
    // The tool_call hook IS the gate — assert it actually registered.
    expect(inline?.handlers.get("tool_call")?.length ?? 0).toBeGreaterThanOrEqual(1);
  });
});
