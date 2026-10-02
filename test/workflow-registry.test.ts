import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listWorkflows, loadWorkflow, findWorkflow } from "../src/workflow/registry.js";

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "wfreg-"));
  fs.mkdirSync(path.join(d, "demo"));
  fs.writeFileSync(path.join(d, "demo", "workflow.yaml"), "name: demo\nsteps:\n  - { id: a, uses: shell, with: { run: echo hi } }\n");
  fs.mkdirSync(path.join(d, "empty")); // no workflow.yaml → ignored
  return d;
}

describe("workflow registry", () => {
  it("lists dirs that contain workflow.yaml", () => {
    const root = tmp();
    expect(listWorkflows(root).map((e) => e.name)).toEqual(["demo"]);
  });
  it("loadWorkflow parses the def", () => {
    const root = tmp();
    const def = loadWorkflow(findWorkflow(root, "demo")!);
    expect(def.steps[0].id).toBe("a");
  });
  it("findWorkflow returns undefined for unknown", () => {
    expect(findWorkflow(tmp(), "nope")).toBeUndefined();
  });
  it("missing root → empty list", () => {
    expect(listWorkflows(path.join(os.tmpdir(), "no-such-wfroot"))).toEqual([]);
  });
});
