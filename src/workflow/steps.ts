import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AnytypeClient } from "../anytype/client.js";
import type { Step } from "./schema.js";

const execFileAsync = promisify(execFile) as unknown as (
  cmd: string, args: string[], opts: { cwd?: string; timeout?: number; maxBuffer?: number },
) => Promise<{ stdout: string; stderr?: string }>;

export interface StepContext {
  api: AnytypeClient;
  /** Default space for `anytype` ops that don't name one. */
  spaceId: string;
  /** cwd for `shell`. */
  workspaceDir: string;
  /** Run a one-shot agent bound to `space` and return its text. */
  runAgent: (space: string, prompt: string, tools?: string[], model?: string) => Promise<string>;
  fetchFn?: typeof fetch;
  exec?: (cmd: string, opts: { cwd?: string; timeoutMs?: number }) => Promise<{ stdout: string; stderr: string }>;
  log?: (line: string) => void;
  /** Approval check for a write-ish action (anytype write / agent step). Absent → allowed. Return false to block. */
  approve?: (action: { tool: string; detail: string }) => Promise<boolean>;
}

const MAX_OUT = 8000;
function clip(s: string): string {
  // NOTE: brief's original used s.trim(); the brief's own shell test asserts
  // stdout "hi\n" is returned verbatim, so we truncate without stripping.
  return s.length > MAX_OUT ? s.slice(0, MAX_OUT) + `\n…（截断，共 ${s.length} 字符）` : s;
}

function str(v: unknown): string {
  return v === undefined || v === null ? "" : String(v);
}

/** Block a write-ish step unless the wired gate approves it (no gate → allowed). */
async function requireApproval(ctx: StepContext, step: Step, tool: string, detail: string): Promise<void> {
  if (!ctx.approve) return;
  const ok = await ctx.approve({ tool, detail });
  if (!ok) throw new Error(`step ${step.id}: 未批准 ${tool}（当前聊天模式不允许写入）`);
}

/** Run one (already-rendered) step and return its output text. */
export async function runStep(step: Step, args: Record<string, unknown>, ctx: StepContext): Promise<string> {
  switch (step.uses) {
    case "shell": {
      const run = str(args.run).trim();
      if (!run) throw new Error(`step ${step.id}: shell needs \`run\``);
      const exec = ctx.exec ?? (async (cmd, o) => {
        const r = await execFileAsync("/bin/sh", ["-c", cmd], { cwd: o.cwd, timeout: o.timeoutMs ?? 60000, maxBuffer: 8 * 1024 * 1024 });
        return { stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
      });
      const { stdout } = await exec(run, { cwd: str(args.cwd) || ctx.workspaceDir, timeoutMs: 60000 });
      return clip(stdout);
    }

    case "anytype": {
      const op = str(args.op);
      const space = str(args.space) || ctx.spaceId;
      switch (op) {
        case "read_object": {
          const doc = await ctx.api.getObjectRaw(space, str(args.id));
          return clip(JSON.stringify(doc));
        }
        case "search": {
          const items = await ctx.api.search(space, str(args.query));
          return clip(JSON.stringify(items));
        }
        case "list_objects": {
          const items = await ctx.api.listObjects(space);
          return clip(JSON.stringify(items));
        }
        case "create_note": {
          await requireApproval(ctx, step, "anytype_create_object", str(args.name));
          const created = await ctx.api.createObject(space, { name: str(args.name), markdown: str(args.markdown) });
          return `created ${created.id}`;
        }
        case "send_message": {
          const chat = str(args.chat);
          if (!chat) throw new Error(`step ${step.id}: send_message needs \`chat\``);
          await requireApproval(ctx, step, "anytype_send_message", `${str(args.chat)}: ${str(args.text)}`);
          await ctx.api.sendMessage(space, chat, str(args.text), `wf-${step.id}-${Date.now()}`);
          return "sent";
        }
        default:
          throw new Error(`step ${step.id}: unknown anytype op ${JSON.stringify(op)}`);
      }
    }

    case "http": {
      const url = str(args.url);
      if (!url) throw new Error(`step ${step.id}: http needs \`url\``);
      const f = ctx.fetchFn ?? fetch;
      const method = str(args.method) || "GET";
      const init: RequestInit = { method };
      if (args.body !== undefined) init.body = str(args.body);
      if (args.headers && typeof args.headers === "object") init.headers = args.headers as Record<string, string>;
      const res = await f(url, init);
      return clip(await res.text());
    }

    case "agent": {
      const prompt = str(args.prompt).trim();
      if (!prompt) throw new Error(`step ${step.id}: agent needs \`prompt\``);
      const space = str(args.space) || ctx.spaceId;
      const tools = Array.isArray(args.tools) ? (args.tools as string[]) : undefined;
      const model = str(args.model) || undefined;
      const fallback = str(args.fallback) || undefined;
      await requireApproval(ctx, step, "agent", prompt.slice(0, 200));
      const attempt = (m?: string): Promise<string> => ctx.runAgent(space, prompt, tools, m);
      let out: string;
      try {
        out = await attempt(model);
      } catch (err) {
        // A dead/misconfigured model often surfaces as a thrown error; try the
        // fallback if one is set, otherwise propagate.
        if (!fallback) throw err;
        ctx.log?.(`step ${step.id}: model ${model ?? "(client default)"} failed (${err instanceof Error ? err.message : String(err)}); trying fallback ${fallback}`);
        out = "";
      }
      // pi can also swallow a model error into an EMPTY reply, so treat empty
      // primary output as a trigger for the fallback too.
      if (out.trim() === "" && fallback) {
        ctx.log?.(`step ${step.id}: model ${model ?? "(client default)"} returned empty; trying fallback ${fallback}`);
        out = await attempt(fallback);
      }
      return clip(out);
    }
  }
}
