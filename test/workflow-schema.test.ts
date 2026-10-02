import { describe, it, expect } from "vitest";
import { parseWorkflow, render, evalIf } from "../src/workflow/schema.js";

const GOOD = `
name: demo
description: a demo
on:
  cron: "0 9 * * *"
  notify: chat123
steps:
  - id: read
    uses: anytype
    with: { op: read_object, id: abc }
  - id: judge
    uses: agent
    with: { space: pqdthe, prompt: "yes or no?" }
    retry: 2
  - id: notify
    if: "{{ steps.judge.output }} == 'yes'"
    uses: anytype
    with: { op: send_message, text: "{{ steps.judge.output }}" }
`;

describe("parseWorkflow", () => {
  it("parses name/on/steps with ids, uses, with, if, retry", () => {
    const d = parseWorkflow(GOOD);
    expect(d.name).toBe("demo");
    expect(d.on).toEqual({ cron: "0 9 * * *", notify: "chat123" });
    expect(d.steps.map((s) => s.id)).toEqual(["read", "judge", "notify"]);
    expect(d.steps[1].uses).toBe("agent");
    expect(d.steps[1].retry).toBe(2);
    expect(d.steps[2].if).toBe("{{ steps.judge.output }} == 'yes'");
  });
  it("rejects a missing name", () => {
    expect(() => parseWorkflow("steps: []")).toThrow(/name/);
  });
  it("rejects a step with no id or a bad uses", () => {
    expect(() => parseWorkflow("name: x\nsteps:\n  - uses: shell\n    with: { run: ls }")).toThrow(/id/);
    expect(() => parseWorkflow("name: x\nsteps:\n  - id: a\n    uses: nope\n    with: {}")).toThrow(/uses/);
  });
  it("rejects duplicate step ids", () => {
    expect(() => parseWorkflow("name: x\nsteps:\n  - { id: a, uses: shell, with: { run: ls } }\n  - { id: a, uses: shell, with: { run: pwd } }")).toThrow(/duplicate/i);
  });
});

describe("render", () => {
  it("substitutes dotted paths, stringifying values", () => {
    expect(render(">{{ steps.judge.output }}<", { steps: { judge: { output: "yes" } } })).toBe(">yes<");
    expect(render("{{ n }}", { n: 42 })).toBe("42");
  });
  it("unknown path → empty string", () => {
    expect(render("[{{ steps.x.output }}]", { steps: {} })).toBe("[]");
  });
  it("leaves non-template text untouched", () => {
    expect(render("hello", {})).toBe("hello");
  });
  it("substitutes step ids that contain hyphens", () => {
    expect(render("{{ steps.my-step.output }}", { steps: { "my-step": { output: "hi" } } })).toBe("hi");
  });
});

describe("evalIf", () => {
  it("compares with == and != after stripping quotes", () => {
    expect(evalIf("yes == 'yes'")).toBe(true);
    expect(evalIf("no == 'yes'")).toBe(false);
    expect(evalIf("yes != 'no'")).toBe(true);
  });
  it("bare value is truthy unless empty/false/0/no", () => {
    expect(evalIf("hello")).toBe(true);
    expect(evalIf("")).toBe(false);
    expect(evalIf("false")).toBe(false);
    expect(evalIf("0")).toBe(false);
    expect(evalIf("no")).toBe(false);
  });
});
