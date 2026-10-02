import { render, evalIf, type WorkflowDef } from "./schema.js";
import { WorkflowRunStore, newRunId, type RunState, type StepState } from "./store.js";
import { runStep, type StepContext } from "./steps.js";

export interface RunEvent {
  runId: string;
  name: string;
  stepId?: string;
  status: string;
  detail?: string;
}
export interface RunOptions {
  store: WorkflowRunStore;
  ctx: StepContext;
  chatId: string;
  spaceId: string;
  trigger: string;
  resumeRunId?: string;
  emit: (event: RunEvent) => void;
  /** Extra template vars (e.g. { env }); merged under `on`/`steps`. */
  scope?: Record<string, unknown>;
}

/** Execute a workflow (or resume one) and return the final run state. */
export async function runWorkflow(def: WorkflowDef, opts: RunOptions): Promise<RunState> {
  const { store } = opts;
  let state: RunState;
  if (opts.resumeRunId) {
    const prev = store.load(opts.resumeRunId);
    if (!prev) throw new Error(`workflow: run ${opts.resumeRunId} not found`);
    state = prev;
    state.status = "running";
  } else {
    state = {
      id: newRunId(),
      name: def.name,
      chatId: opts.chatId,
      spaceId: opts.spaceId,
      trigger: opts.trigger,
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: def.steps.map((s) => ({ id: s.id, uses: s.uses, status: "pending" })),
    };
    store.create(state);
  }
  const byId = new Map<string, StepState>(state.steps.map((s) => [s.id, s]));
  for (const s of def.steps) if (!byId.has(s.id)) { const ns: StepState = { id: s.id, uses: s.uses, status: "pending" }; state.steps.push(ns); byId.set(s.id, ns); }

  store.log(state.id, `▶ run ${state.id} (${def.name}) trigger=${opts.trigger}`);
  opts.emit({ runId: state.id, name: def.name, status: "run-start" });

  const scopeOf = (): Record<string, unknown> => ({
    on: { ...(def.on ?? {}), ...(opts.trigger ? { trigger: opts.trigger } : {}) },
    steps: Object.fromEntries(state.steps.map((s) => [s.id, { output: s.output ?? "" }])),
    ...(opts.scope ?? {}),
  });

  for (const step of def.steps) {
    const ss = byId.get(step.id)!;
    if (ss.status === "done") continue;              // resume: skip finished

    if (step.if !== undefined && !evalIf(render(step.if, scopeOf()))) {
      ss.status = "skipped";
      store.save(state);
      store.log(state.id, `⏭ ${step.id} (if false)`);
      opts.emit({ runId: state.id, name: def.name, stepId: step.id, status: "skipped" });
      continue;
    }

    ss.status = "running";
    ss.startedAt = new Date().toISOString();
    store.save(state);
    opts.emit({ runId: state.id, name: def.name, stepId: step.id, status: "running" });

    const rendered = Object.fromEntries(
      Object.entries(step.with).map(([k, v]) => [k, typeof v === "string" ? render(v, scopeOf()) : v]),
    );

    const attempts = (step.retry ?? 0) + 1;
    let lastErr: unknown;
    let ok = false;
    for (let i = 0; i < attempts; i++) {
      try {
        const out = await runStep(step, rendered, opts.ctx);
        ss.status = "done";
        ss.output = out;
        ss.endedAt = new Date().toISOString();
        delete ss.error;
        store.writeStepOutput(state.id, step.id, out);
        ok = true;
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!ok) {
      ss.status = "failed";
      ss.error = lastErr instanceof Error ? lastErr.message : String(lastErr);
      ss.endedAt = new Date().toISOString();
      state.status = "failed";
      store.save(state);
      store.log(state.id, `❌ ${step.id}: ${ss.error}`);
      opts.emit({ runId: state.id, name: def.name, stepId: step.id, status: "failed", detail: ss.error });
      return state;                                   // abort the run
    }
    store.save(state);
    store.log(state.id, `✅ ${step.id}`);
    opts.emit({ runId: state.id, name: def.name, stepId: step.id, status: "done", detail: ss.output });
  }

  state.status = "done";
  store.save(state);
  store.log(state.id, `✅ run ${state.id} done`);
  opts.emit({ runId: state.id, name: def.name, status: "done" });
  return state;
}
