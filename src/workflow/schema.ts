import { parse as parseYaml } from "yaml";

export type StepUse = "shell" | "anytype" | "http" | "agent";
const USES = new Set<StepUse>(["shell", "anytype", "http", "agent"]);

export interface Step {
  id: string;
  uses: StepUse;
  with: Record<string, unknown>;
  /** Simple guard, e.g. "{{ steps.judge.output }} == 'yes'". Rendered then eval'd. */
  if?: string;
  /** Retry attempts on failure (in addition to the first try). Default 0. */
  retry?: number;
}

export interface WorkflowDef {
  name: string;
  description?: string;
  on?: { cron?: string; notify?: string };
  steps: Step[];
}

/** Parse + validate a workflow.yaml. Throws with a clear message on anything invalid. */
export function parseWorkflow(yamlText: string): WorkflowDef {
  const raw = parseYaml(yamlText) as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object") throw new Error("workflow: empty or not an object");
  const name = raw.name;
  if (typeof name !== "string" || name.trim() === "") throw new Error("workflow: `name` is required");
  const stepsRaw = raw.steps;
  if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) throw new Error("workflow: `steps` must be a non-empty array");
  const seen = new Set<string>();
  const steps: Step[] = stepsRaw.map((s, i) => {
    if (!s || typeof s !== "object") throw new Error(`workflow: step ${i} is not an object`);
    const st = s as Record<string, unknown>;
    const id = st.id;
    if (typeof id !== "string" || id.trim() === "") throw new Error(`workflow: step ${i} needs an \`id\``);
    if (seen.has(id)) throw new Error(`workflow: duplicate step id \`${id}\``);
    seen.add(id);
    const uses = st.uses;
    if (typeof uses !== "string" || !USES.has(uses as StepUse)) {
      throw new Error(`workflow: step \`${id}\` has invalid \`uses\` (want shell|anytype|http|agent)`);
    }
    const withRaw = st.with;
    const withObj = withRaw && typeof withRaw === "object" ? (withRaw as Record<string, unknown>) : {};
    const step: Step = { id, uses: uses as StepUse, with: withObj };
    if (typeof st.if === "string") step.if = st.if;
    if (typeof st.retry === "number" && st.retry >= 0) step.retry = st.retry;
    return step;
  });
  const def: WorkflowDef = { name, steps };
  if (typeof raw.description === "string") def.description = raw.description;
  const onRaw = raw.on;
  if (onRaw && typeof onRaw === "object") {
    const on = onRaw as Record<string, unknown>;
    const onObj: { cron?: string; notify?: string } = {};
    if (typeof on.cron === "string") onObj.cron = on.cron;
    if (typeof on.notify === "string") onObj.notify = on.notify;
    if (Object.keys(onObj).length > 0) def.on = onObj;
  }
  return def;
}

/** Look up a dotted path in a nested object; undefined when missing. */
function lookup(scope: Record<string, unknown>, path: string): unknown {
  let cur: unknown = scope;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Replace every `{{ dotted.path }}` with the scope value (String(...)); unknown → "". */
export function render(tpl: string, scope: Record<string, unknown>): string {
  return tpl.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, path: string) => {
    const v = lookup(scope, path);
    return v === undefined || v === null ? "" : String(v);
  });
}

const FALSY = new Set(["", "false", "0", "no"]);

/**
 * Evaluate a rendered guard. Supports `<lhs> == <rhs>` / `<lhs> != <rhs>`
 * (string compare, surrounding quotes stripped); otherwise truthiness of the
 * whole string (empty / "false" / "0" / "no" → false).
 */
export function evalIf(rendered: string): boolean {
  const eq = rendered.match(/^(.*?)\s*(==|!=)\s*(.*)$/);
  if (eq) {
    const strip = (s: string): string => s.trim().replace(/^['"]|['"]$/g, "");
    const a = strip(eq[1]);
    const b = strip(eq[3]);
    return eq[2] === "==" ? a === b : a !== b;
  }
  return !FALSY.has(rendered.trim().toLowerCase());
}
