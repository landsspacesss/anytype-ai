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
