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
