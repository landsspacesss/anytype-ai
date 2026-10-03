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
  it("splits embedded newlines so each log record stays one line", () => {
    const root = tmpRoot();
    const store = new WorkflowRunStore(root);
    store.create(mkState("r3"));
    store.log("r3", "line1\r\nline2");
    const log = fs.readFileSync(path.join(store.dir("r3"), "log.ndjson"), "utf-8").trim().split("\n");
    expect(log).toEqual(["line1", "line2"]);
  });
  it("load returns null for a missing run", () => {
    expect(new WorkflowRunStore(tmpRoot()).load("nope")).toBeNull();
  });
  it("rejects unsafe run ids (path traversal)", () => {
    const store = new WorkflowRunStore(tmpRoot());
    expect(() => store.dir("../../etc")).toThrow(/unsafe/);
    expect(() => store.dir("..")).toThrow(/unsafe/);
  });
});

describe("newRunId", () => {
  it("is filesystem-safe and unique-ish", () => {
    const id = newRunId(new Date("2026-10-03T09:00:00Z"));
    expect(id).toMatch(/^[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/);
  });
});
