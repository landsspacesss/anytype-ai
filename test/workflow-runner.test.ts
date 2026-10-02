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
