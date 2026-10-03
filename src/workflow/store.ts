import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";
export interface StepState {
  id: string;
  uses: string;
  status: StepStatus;
  output?: string;
  error?: string;
  startedAt?: string;
  endedAt?: string;
}
export type RunStatus = "running" | "done" | "failed";
export interface RunState {
  id: string;
  name: string;
  chatId: string;
  spaceId: string;
  trigger: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  steps: StepState[];
}

/** A fresh, filesystem-safe run id: YYYYMMDD-HHMMSS-<4hex>. */
export function newRunId(now: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${stamp}-${crypto.randomBytes(2).toString("hex")}`;
}

/** Persistence for workflow runs: one directory per run under `root`. */
export class WorkflowRunStore {
  constructor(private readonly root: string) {}

  dir(id: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(id) || id === "." || id === "..") {
      throw new Error(`workflow: unsafe run id ${JSON.stringify(id)}`);
    }
    return path.join(this.root, id);
  }

  create(state: RunState): void {
    fs.mkdirSync(this.dir(state.id), { recursive: true });
    this.save(state);
  }

  load(id: string): RunState | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir(id), "state.json"), "utf-8")) as RunState;
    } catch {
      return null;
    }
  }

  save(state: RunState): void {
    state.updatedAt = new Date().toISOString();
    const d = this.dir(state.id);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "state.json"), JSON.stringify(state, null, 2), "utf-8");
  }

  log(id: string, line: string): void {
    const d = this.dir(id);
    fs.mkdirSync(d, { recursive: true });
    for (const part of String(line).split(/\r?\n/)) {
      fs.appendFileSync(path.join(d, "log.ndjson"), part + "\n", "utf-8");
    }
  }

  writeStepOutput(id: string, stepId: string, text: string): string {
    const d = path.join(this.dir(id), "steps");
    fs.mkdirSync(d, { recursive: true });
    const p = path.join(d, `${stepId}.out`);
    fs.writeFileSync(p, text, "utf-8");
    return p;
  }
}
