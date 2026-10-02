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
