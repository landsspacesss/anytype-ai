import fs from "node:fs";
import path from "node:path";
import { parseWorkflow, type WorkflowDef } from "./schema.js";

export interface WorkflowEntry {
  name: string;
  description?: string;
  dir: string;
  file: string;
}

/** Scan `root` for `<name>/workflow.yaml` dirs. Missing root → []. */
export function listWorkflows(root: string): WorkflowEntry[] {
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: WorkflowEntry[] = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const file = path.join(root, d.name, "workflow.yaml");
    if (!fs.existsSync(file)) continue;
    const entry: WorkflowEntry = { name: d.name, dir: path.join(root, d.name), file };
    try {
      const def = parseWorkflow(fs.readFileSync(file, "utf-8"));
      if (def.description) entry.description = def.description;
    } catch {
      // unparseable — still list it so `/run` can surface the error later
    }
    out.push(entry);
  }
  return out;
}

export function loadWorkflow(entry: WorkflowEntry): WorkflowDef {
  return parseWorkflow(fs.readFileSync(entry.file, "utf-8"));
}

export function findWorkflow(root: string, name: string): WorkflowEntry | undefined {
  return listWorkflows(root).find((e) => e.name === name);
}
