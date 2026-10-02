import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPiClient, ensureAgentFiles, type PiClientOptions } from "../src/agent/pi-session.js";
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
