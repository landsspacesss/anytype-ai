import type { InterruptPolicy, ManagedClient } from "../session/manager.js";
import type { ApprovalMode } from "../agent/approval.js";

/** Everything a command needs: the chat's client + a way to reset its session. */
export interface CommandContext {
  /** The chat this command arrived in. */
  chatId: string;
  /** The live client for the chat, if one exists (does NOT create one). */
  getClient(): ManagedClient | undefined;
  /** Get-or-create the chat's client (for commands that mutate settings). */
  ensureClient(): Promise<ManagedClient>;
  /** Forget this chat's session so the next turn starts fresh. */
  reset(): Promise<void>;
  /** Model id to report when no live client / model is available. */
  defaultModel: string;
  /** The chat's current interrupt policy. */
  getInterruptPolicy(): InterruptPolicy;
  /**
   * Set the chat's interrupt policy and apply it immediately — a turn that is
   * already running is interrupted per the new policy.
   */
  setInterruptPolicy(policy: InterruptPolicy): Promise<InterruptPolicy>;
  /**
   * Join a space from a link: an invite link adds the bot to that space; a 1:1
   * link connects the bot to the user's one-to-one console. Returns a
   * human-readable result message.
   */
  joinSpace(link: string): Promise<{ ok: boolean; message: string }>;
  /** Run a workflow. `args` are `k=v` pairs; when `resumeRunId` is set, continue that run. */
  runWorkflow(name: string, args: string, resumeRunId?: string): Promise<{ ok: boolean; message: string }>;
  /** Available workflow names (+ optional description) on disk. */
  listWorkflows(): { name: string; description?: string }[];
  /** Recent workflow runs (newest first). */
  listRuns(): { id: string; name: string; status: string; when: string }[];
  /** True when this chat is the global console space (always read-only). */
  isConsole: boolean;
  /** Console only: whether the console is unlocked (may dispatch workers). */
  getConsoleUnlocked(): boolean;
  /** Console only: set the console lock; returns the applied value. */
  setConsoleUnlocked(on: boolean): boolean;
  /** Current approval mode for this chat. */
  getApprovalMode(): ApprovalMode;
  /** Set the approval mode; returns the applied mode. */
  setApprovalMode(mode: ApprovalMode): ApprovalMode;
  /** Resolve a pending approval. Returns true if one was pending. */
  approvePending(kind: "approve" | "all" | "deny"): boolean;
}

/** Thinking levels `/effort` accepts (pi clamps to what the model supports). */
const EFFORT_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * Render the models the bot can actually switch to (those whose provider has a
 * configured key). Input entries are `provider/id`. Long lists are capped.
 */
export function availableModelsText(models: string[]): string {
  if (models.length === 0) return "";
  const byProvider = new Map<string, string[]>();
  for (const m of models) {
    const slash = m.indexOf("/");
    const prov = slash === -1 ? "" : m.slice(0, slash);
    const id = slash === -1 ? m : m.slice(slash + 1);
    (byProvider.get(prov) ?? byProvider.set(prov, []).get(prov)!).push(id);
  }
  const parts: string[] = [];
  for (const [prov, ids] of byProvider) parts.push(`${prov}: ${ids.join(", ")}`);
  let text = parts.join("；");
  if (text.length > 400) text = text.slice(0, 400) + "…";
  return `（可用模型 — ${text}）`;
}

/** Human-readable label for an interrupt policy. */
export function interruptLabel(p: InterruptPolicy): string {
  return p === "immediate" ? "立刻打断" : "等这一步结束";
}

/** Human-readable label for an approval mode. */
export function approvalLabel(m: ApprovalMode): string {
  return m === "auto" ? "auto（不问，直接执行）" : m === "ask" ? "ask（每次写操作需批准）" : "readonly（不能写）";
}

export const HELP_TEXT = [
  "可用指令：",
  "/new — 开始新对话（清空当前会话历史）",
  "/clear — 同 /new",
  "/compact — 压缩/精简当前对话",
  "/model [名称] — 查看或切换本对话的模型",
  "/effort [档位] — 查看或设置思考级别（档位取决于模型，通常 off|high|max）",
  "/yolo [auto|ask|readonly] — 审批模式：auto=不问，ask=写操作需批准（/yolo off），readonly=不能写（/yolo readonly）（控制台：auto=解锁派 worker，readonly=锁定）",
  "/approve [all] — 批准待批准的操作（all=本回合剩余全放行）",
  "/deny — 拒绝待批准的操作",
  "/interrupt [now|step] — 打断策略：now=立刻打断，step=等当前这一步结束（默认）",
  "/join <链接> — 加入一个空间（邀请链接）或接入 1:1 控制台（1:1 链接）",
  "/run <工作流> [k=v …] — 运行一个工作流（不带参数=列出可用工作流；--resume <id> 从断点续跑）",
  "/runs — 列出最近的工作流运行",
  "/help — 显示本帮助",
].join("\n");

/**
 * Handle a slash command for one chat.
 *
 * Returns the reply text. Unknown commands return a `未知指令` hint (never
 * null in practice); null is reserved for "no reply / fall through".
 */
export async function handleCommand(
  cmd: string,
  args: string,
  ctx: CommandContext,
): Promise<string | null> {
  const command = cmd.toLowerCase();
  switch (command) {
    case "new":
    case "clear": {
      await ctx.reset();
      return "已开始新的对话（历史已清空）。";
    }

    case "compact": {
      const client = await ctx.ensureClient();
      if (!client.compact) return "当前会话不支持压缩。";
      const status = await client.compact();
      return `已压缩当前对话：${status}`;
    }

    case "model": {
      const live = ctx.getClient();
      const availText = availableModelsText(live?.getAvailableModels?.() ?? []);
      if (!args) {
        const current = live?.getModel?.() ?? ctx.defaultModel;
        return `当前模型：${current}${availText}`;
      }
      const client = await ctx.ensureClient();
      if (!client.setModel) return "当前会话不支持切换模型。";
      const resolved = await client.setModel(args);
      return resolved
        ? `已切换模型：${resolved}`
        : `未知模型：${args}（未改动，当前仍是 ${client.getModel?.() ?? ctx.defaultModel}）${availText}`;
    }

    case "effort": {
      // The levels a model actually supports vary (DeepSeek V4 only has
      // off|high|max); report the real set rather than a fixed list, so we
      // never silently clamp a level the model can't reach.
      const live = ctx.getClient();
      const available = live?.getAvailableThinkingLevels?.() ?? [];
      const availText = available.length > 0 ? available.join("|") : "low|medium|high|max";
      if (!args) {
        const current = live?.getThinkingLevel?.() ?? "默认";
        return `当前思考级别：${current}（本模型可用：${availText}）`;
      }
      const level = args.toLowerCase();
      const ok = available.length > 0
        ? available.includes(level) || (level === "xhigh" && available.includes("max"))
        : EFFORT_LEVELS.has(level);
      if (!ok) {
        return `本模型不支持思考级别「${args}」，可用：${availText}`;
      }
      const client = await ctx.ensureClient();
      if (!client.setThinkingLevel) return "当前会话不支持设置思考级别。";
      const applied = client.setThinkingLevel(level);
      return `已设置思考级别：${applied}`;
    }

    case "yolo": {
      // The console has no approval mode — its own tools are always read-only.
      // /yolo here just LOCKS/UNLOCKS the ability to dispatch workers.
      if (ctx.isConsole) {
        if (!args) {
          return `控制台：${ctx.getConsoleUnlocked() ? "已解锁（可派 worker 到其它空间）" : "锁定（只读，不能派 worker）"}`;
        }
        const a = args.toLowerCase();
        if (a === "auto" || a === "on") {
          ctx.setConsoleUnlocked(true);
          return "控制台已解锁：可派 worker 到其它空间（写入由该 worker 执行）。";
        }
        if (a === "readonly" || a === "ro" || a === "ask" || a === "off") {
          ctx.setConsoleUnlocked(false);
          return "控制台已锁定：只读，不能派 worker。";
        }
        return `用法：/yolo auto|readonly（控制台：auto=解锁，readonly=锁定）`;
      }
      if (!args) {
        return `审批模式：${approvalLabel(ctx.getApprovalMode())}`;
      }
      const arg = args.toLowerCase();
      let mode: ApprovalMode;
      if (arg === "auto" || arg === "on") mode = "auto";
      else if (arg === "ask" || arg === "off") mode = "ask";
      else if (arg === "readonly" || arg === "ro") mode = "readonly";
      else return `用法：/yolo [auto|ask|readonly]（当前：${approvalLabel(ctx.getApprovalMode())}）`;
      const applied = ctx.setApprovalMode(mode);
      return `审批模式已设为：${approvalLabel(applied)}`;
    }

    case "approve": {
      const kind = args.trim().toLowerCase() === "all" ? "all" : "approve";
      const had = ctx.approvePending(kind);
      return had
        ? kind === "all" ? "已批准本次及本回合后续操作。" : "已批准本次操作。"
        : "当前没有待批准的操作。";
    }

    case "deny": {
      const had = ctx.approvePending("deny");
      return had ? "已拒绝该操作。" : "当前没有待批准的操作。";
    }

    case "interrupt": {
      if (!args) {
        return `打断策略：${interruptLabel(ctx.getInterruptPolicy())}（用 /interrupt now|step 修改）`;
      }
      const arg = args.toLowerCase();
      let policy: InterruptPolicy | undefined;
      if (arg === "now" || arg === "immediate" || arg === "立刻") policy = "immediate";
      else if (arg === "step" || arg === "wait" || arg === "等") policy = "step";
      if (!policy) {
        return "用法：/interrupt [now|step]（now=立刻打断，step=等当前这一步结束）";
      }
      const applied = await ctx.setInterruptPolicy(policy);
      return `打断策略已设为：${interruptLabel(applied)}（立即生效）`;
    }

    case "join": {
      if (!args) return "用法：/join <链接>（邀请链接，或 1:1 链接以接入控制台）";
      const r = await ctx.joinSpace(args);
      return r.message;
    }

    case "run": {
      const usage = "用法：/run <工作流名> [k=v …]（/run <名> --resume <runId> 续跑；/runs 看历史）";
      if (!args) {
        const defs = ctx.listWorkflows();
        if (defs.length === 0) return `${usage}\n（暂无可用工作流）`;
        const lines = defs.map((w) => `· ${w.name}${w.description ? ` — ${w.description}` : ""}`);
        return `${usage}\n\n可用工作流：\n${lines.join("\n")}`;
      }
      const resumeMatch = args.match(/\s--resume\s+(\S+)/);
      if (!resumeMatch && /\s--resume(\s|$)/.test(args)) {
        return "用法：/run <名> --resume <runId>（--resume 后面需要 runId）";
      }
      const resumeRunId = resumeMatch ? resumeMatch[1] : undefined;
      const name = args.split(/\s+/)[0];
      const rest = args
        .replace(/^\S+\s*/, "")
        .replace(/--resume\s+\S+/, "")
        .replace(/\s+/g, " ")
        .trim();
      const r = await ctx.runWorkflow(name, rest, resumeRunId);
      return r.message;
    }
    case "runs": {
      const rows = ctx.listRuns();
      if (rows.length === 0) return "还没有工作流运行记录。";
      return rows.map((r) => `${r.status === "done" ? "✅" : r.status === "failed" ? "❌" : "▶"} ${r.id} ${r.name} (${r.status}) ${r.when}`).join("\n");
    }

    case "help":
      return HELP_TEXT;

    default:
      if (command === "") return HELP_TEXT;
      return `未知指令：/${command}（输入 /help 查看）`;
  }
}
