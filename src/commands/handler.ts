import type { InterruptPolicy, ManagedClient } from "../session/manager.js";

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
}

/** Thinking levels `/effort` accepts (pi clamps to what the model supports). */
const EFFORT_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);

/** Human-readable label for an interrupt policy. */
export function interruptLabel(p: InterruptPolicy): string {
  return p === "immediate" ? "立刻打断" : "等这一步结束";
}

export const HELP_TEXT = [
  "可用指令：",
  "/new — 开始新对话（清空当前会话历史）",
  "/clear — 同 /new",
  "/compact — 压缩/精简当前对话",
  "/model [名称] — 查看或切换本对话的模型",
  "/effort [档位] — 查看或设置思考级别（档位取决于模型，通常 off|high|max）",
  "/yolo [on|off] — 开关 YOLO 自动模式（默认开）",
  "/interrupt [now|step] — 打断策略：now=立刻打断，step=等当前这一步结束（默认）",
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
      if (!args) {
        const client = ctx.getClient();
        const current = client?.getModel?.() ?? ctx.defaultModel;
        return `当前模型：${current}`;
      }
      const client = await ctx.ensureClient();
      if (!client.setModel) return "当前会话不支持切换模型。";
      const resolved = await client.setModel(args);
      return resolved
        ? `已切换模型：${resolved}`
        : `未知模型：${args}（未改动，当前仍是 ${client.getModel?.() ?? ctx.defaultModel}）`;
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
      const client = ctx.getClient();
      if (!args) {
        const on = client?.isAutoTools?.() ?? true;
        return `YOLO 自动模式：${on ? "开" : "关"}`;
      }
      const arg = args.toLowerCase();
      if (arg !== "on" && arg !== "off") {
        return `用法：/yolo [on|off]（当前：${(client?.isAutoTools?.() ?? true) ? "开" : "关"}）`;
      }
      const target = arg === "on";
      const live = await ctx.ensureClient();
      if (!live.setAutoTools) return "当前会话不支持自动模式切换。";
      const status = live.setAutoTools(target);
      return status;
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

    case "help":
      return HELP_TEXT;

    default:
      if (command === "") return HELP_TEXT;
      return `未知指令：/${command}（输入 /help 查看）`;
  }
}
