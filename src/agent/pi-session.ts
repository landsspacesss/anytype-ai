import fs from "node:fs";
import path from "node:path";
import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import type { ManagedClient, ProgressCallback } from "../session/manager.js";
import type { AnytypeClient } from "../anytype/client.js";
import type { WatchStore } from "../watch/store.js";
import { DEFAULT_WATCH_CRON } from "../watch/store.js";
import { createAnytypeTools } from "./anytype-tools.js";
import { SubagentRegistry } from "./subagents.js";
import type { ChildAgent } from "./subagents.js";

export interface PiClientOptions {
  /** Working directory for the agent (its project-local context lives here). */
  cwd: string;
  /** Global pi config dir. Defaults to pi's own `~/.pi/agent`. */
  agentDir?: string;
  /** Shared Anytype client used by the Anytype tools. */
  api: AnytypeClient;
  /** The Anytype space this agent lives in. */
  spaceId: string;
  /** Durable object-change subscriptions shared across sessions. */
  store: WatchStore;
  /** The chat this session belongs to — watch notifications go back here. */
  chatId: string;
  /** Default cron for new watches (env WATCH_DEFAULT_CRON). */
  defaultWatchCron?: string;
  /** Model id to use (e.g. "deepseek-flash"). Defaults to pi's own default. */
  modelId?: string;
  /** DeepSeek key backing the `web_search` tool (env DEEPSEEK_API_KEY). Empty disables it. */
  searchApiKey?: string;
  /** Model for the `web_search` tool (env SEARCH_MODEL). Defaults to the search fn's default. */
  searchModel?: string;
  /** Lightpanda binary backing the `web_fetch` tool (env LIGHTPANDA_BIN). */
  lightpandaBin?: string;
  /** Timeout (ms) for a `web_fetch` run (env WEB_FETCH_TIMEOUT_MS). */
  webFetchTimeoutMs?: number;
  /** Max characters returned by `web_fetch` (env WEB_FETCH_MAX_CHARS). */
  webFetchMaxChars?: number;
  /** Live named sub-agent cap for the `agent` tool (env MAX_SUBAGENTS). Default 5. */
  maxSubagents?: number;
  /** Idle (ms) after which a non-busy named sub-agent is reaped (env SUBAGENT_IDLE_MS). Default 900000. */
  subagentIdleMs?: number;
  /**
   * Directory holding THIS chat's persisted pi session (JSONL). When set, the
   * top-level session is continued from the most recent file in it (or created
   * fresh if none), so history survives a process restart. When unset the
   * session stays in-memory (tests / callers that don't want persistence).
   */
  chatSessionDir?: string;
  /**
   * Whether to resume the most recent persisted session in `chatSessionDir`.
   * Default true (normal restart behavior). Pass false to START FRESH — used
   * after `/new` so the new conversation does not recall old history.
   */
  resume?: boolean;
}

/** Tool names kept when YOLO / auto-approve mode is OFF (read-only safety set). */
export const READONLY_TOOLS: readonly string[] = [
  "anytype_list_objects",
  "anytype_search",
  "anytype_read_object",
  "anytype_download_images",
  "anytype_download_file",
  "crop_image",
  "anytype_list_properties",
  "anytype_list_types",
  "anytype_templates",
  "web_search",
  "web_fetch",
  "anytype_watch",
];

/** Where the baked-in custom model registry lives in the image. */
const MODELS_SRC = "/app/pi/models.json";

/**
 * Copy the custom model registry (docker/models.json) into pi's agent dir if it
 * isn't there yet. The agent dir is a volume mount, so a baked-in file at that
 * path would be shadowed — we copy it in at startup instead.
 */
export function ensureModelsConfig(agentDir: string, srcPath: string = MODELS_SRC): void {
  try {
    fs.mkdirSync(agentDir, { recursive: true });
    const dest = path.join(agentDir, "models.json");
    if (!fs.existsSync(dest) && fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, dest);
      console.log(`wrote model registry: ${dest}`);
    }
  } catch (err) {
    console.warn(`ensureModelsConfig failed: ${String(err)}`);
  }
}

/** Find a model by id, preferring the deepseek provider. */
function resolveModel(registry: ModelRegistry, modelId: string): unknown | undefined {
  const all = (registry as unknown as { getAll?: () => Array<{ id: string; provider?: string }> }).getAll?.() ?? [];
  return (
    all.find((m) => m.id === modelId && m.provider === "deepseek") ??
    all.find((m) => m.id === modelId)
  );
}

/**
 * Build a ManagedClient backed by an in-process pi SDK AgentSession.
 *
 * Replaces the old omp subprocess: no RPC framing, no `ready` handshake, and
 * no child process to supervise. `session.prompt()` resolves when the turn
 * completes, at which point `collected` holds the assistant's reply text that
 * we accumulated from `text_delta` streaming events.
 */
export async function createPiClient(opts: PiClientOptions): Promise<ManagedClient> {
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const model = opts.modelId ? resolveModel(modelRegistry, opts.modelId) : undefined;
  if (opts.modelId && !model) {
    console.warn(`pi model "${opts.modelId}" not found in registry; using pi default`);
  }
  // Build a fresh, isolated child session. The child gets the same Anytype
  // tools but NO subagent/agent tool, so it cannot recurse.
  const createChildAgent = async (): Promise<ChildAgent> => {
    const { session: child } = await createAgentSession({
      cwd: opts.cwd,
      agentDir: opts.agentDir,
      authStorage,
      modelRegistry,
      sessionManager: SessionManager.inMemory(),
      customTools: createAnytypeTools({
        api: opts.api, spaceId: opts.spaceId, workspaceDir: opts.cwd, store: opts.store,
        chatId: opts.chatId, defaultWatchCron: opts.defaultWatchCron ?? DEFAULT_WATCH_CRON,
        searchApiKey: opts.searchApiKey ?? "", searchModel: opts.searchModel,
        lightpandaBin: opts.lightpandaBin, webFetchTimeoutMs: opts.webFetchTimeoutMs,
        webFetchMaxChars: opts.webFetchMaxChars,
        // NOTE: no runSubagent and no agentRegistry → the child cannot spawn
        // further sub-agents (no recursion).
      }),
      ...(model ? { model: model as never } : {}),
    });
    let collected = "";
    const unsub = child.subscribe((e) => {
      if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") {
        collected += e.assistantMessageEvent.delta;
      }
    });
    return {
      get busy(): boolean {
        return child.isStreaming;
      },
      async prompt(text: string): Promise<string> {
        collected = "";
        await child.prompt(text);
        return collected;
      },
      dispose(): void {
        unsub();
        child.dispose();
      },
    };
  };

  // One-shot delegation: a fresh child per call, disposed when the task ends.
  const runSubagent = async (task: string): Promise<string> => {
    const a = await createChildAgent();
    try {
      return await a.prompt(task);
    } finally {
      a.dispose();
    }
  };

  // Persistent, named sub-agents for the parent's `agent` tool.
  const agentRegistry = new SubagentRegistry({
    create: () => createChildAgent(),
    maxAgents: opts.maxSubagents ?? 5,
    idleMs: opts.subagentIdleMs ?? 900000,
  });

  // The TOP-LEVEL per-chat session persists to disk when a session dir is
  // given: `continueRecent` reopens the most recent JSONL there (or starts one
  // fresh), so history survives a process restart. Sub-agents (created above)
  // deliberately stay ephemeral — only this session is durable.
  let sessionManager: SessionManager;
  if (opts.chatSessionDir) {
    fs.mkdirSync(opts.chatSessionDir, { recursive: true });
    // resume === false (after /new) starts a NEW JSONL in the same dir instead
    // of reopening the most recent one, so old history is not recalled.
    sessionManager =
      opts.resume === false
        ? SessionManager.create(opts.cwd, opts.chatSessionDir)
        : SessionManager.continueRecent(opts.cwd, opts.chatSessionDir);
  } else {
    sessionManager = SessionManager.inMemory(opts.cwd);
  }

  const { session } = await createAgentSession({
    cwd: opts.cwd,
    agentDir: opts.agentDir,
    authStorage,
    modelRegistry,
    sessionManager,
    customTools: createAnytypeTools({
      api: opts.api,
      spaceId: opts.spaceId,
      workspaceDir: opts.cwd,
      store: opts.store,
      chatId: opts.chatId,
      defaultWatchCron: opts.defaultWatchCron ?? DEFAULT_WATCH_CRON,
      searchApiKey: opts.searchApiKey ?? "",
      searchModel: opts.searchModel,
      lightpandaBin: opts.lightpandaBin,
      webFetchTimeoutMs: opts.webFetchTimeoutMs,
      webFetchMaxChars: opts.webFetchMaxChars,
      runSubagent,
      agentRegistry,
    }),
    ...(model ? { model: model as never } : {}),
  });

  let collected = "";
  // Set for the duration of the current top-level prompt(); lets the session
  // event handler forward tool-call starts to the caller's progress callback.
  // Sub-agents/child sessions never set this, so they are unaffected.
  let currentProgress: ProgressCallback | undefined;
  const unsubscribe = session.subscribe((e) => {
    if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") {
      collected += e.assistantMessageEvent.delta;
    } else if (e.type === "tool_execution_start") {
      // Guard the shape: only forward a well-formed event, and only when a
      // caller is listening.
      if (currentProgress && typeof e.toolName === "string") {
        currentProgress({ tool: e.toolName, args: e.args });
      }
    }
  });

  // YOLO / auto-approve: ON means every tool is active. OFF restricts to a
  // read-only safety set (no create/update/delete/edit/chat-send/upload/
  // subagent/agent). Default ON.
  let autoTools = true;
  const applyTools = (): void => {
    const names = autoTools ? session.getAllTools().map((t) => t.name) : [...READONLY_TOOLS];
    session.setActiveToolsByName(names);
  };
  // Establish the default (all tools) explicitly, so the agent's active set
  // matches our model of it from the first turn.
  applyTools();

  return {
    get busy(): boolean {
      return session.isStreaming;
    },
    async prompt(m: string, onProgress?: ProgressCallback): Promise<string> {
      collected = "";
      currentProgress = onProgress;
      try {
        await session.prompt(m);
        return collected;
      } finally {
        currentProgress = undefined;
      }
    },
    async close(): Promise<void> {
      agentRegistry.killAll();
      unsubscribe();
      session.dispose();
    },
    async abort(): Promise<void> {
      await session.abort();
    },
    // --- per-chat control ops (slash commands) ---
    getModel(): string {
      return session.model?.id ?? "(pi default)";
    },
    async setModel(id: string): Promise<string | null> {
      const model = resolveModel(modelRegistry, id);
      if (!model) return null;
      await session.setModel(model as never);
      return session.model?.id ?? id;
    },
    getThinkingLevel(): string {
      return session.thinkingLevel;
    },
    setThinkingLevel(level: string): string {
      // `/effort max` maps to pi's `xhigh`. Other levels pass through and are
      // clamped by pi to what the model supports.
      const mapped = level === "max" ? "xhigh" : level;
      session.setThinkingLevel(mapped as Parameters<typeof session.setThinkingLevel>[0]);
      return session.thinkingLevel;
    },
    async compact(): Promise<string> {
      const r = await session.compact();
      const before = typeof r.tokensBefore === "number" ? `（压缩前 ${r.tokensBefore} tokens）` : "";
      return `已压缩当前对话${before}`;
    },
    setAutoTools(enabled: boolean): string {
      autoTools = enabled;
      applyTools();
      return enabled ? "YOLO 自动模式：开" : "YOLO 自动模式：关";
    },
    isAutoTools(): boolean {
      return autoTools;
    },
  };
}

/**
 * Per-space manual memory: ensure the workspace has an AGENTS.md that tells the
 * agent to read/write a durable MEMORY.md. pi auto-loads AGENTS.md context
 * files found in (and above) `cwd`, so this is picked up on session creation.
 * Existing AGENTS.md is never clobbered.
 */
export function ensureAgentFiles(workspaceDir: string): void {
  fs.mkdirSync(workspaceDir, { recursive: true });
  const agentsMd = path.join(workspaceDir, "AGENTS.md");
  if (fs.existsSync(agentsMd)) return;
  const body = [
    "# Identity",
    "",
    "You are an AI assistant living inside an Anytype space. The user's notes and",
    "pages live in Anytype — use the `anytype_*` tools to read them. Do not confuse",
    "Anytype content with local files.",
    "",
    "非图片的散文件（PDF、docx、xlsx、txt 等）不在任何页面里：先用",
    "`anytype_download_file` 把它下载到本地，再用 shell 工具",
    "（`pdftotext`/`unzip`/`python3`/`cat`）自行解析内容。图片用",
    "`anytype_read_object` 直接查看。",
    "",
    "# 聊天输出格式（重要）",
    "",
    "你在 Anytype 聊天里发的消息使用**纯文本**，**不要输出 Markdown 语法**。",
    "Anytype 聊天不渲染 Markdown，会把这些符号原样显示出来，很难看。所以：",
    "- 不要用 `#`/`##` 标题、`**粗体**`、`*斜体*`、行内 `` `代码` `` 或 ``` 围栏代码块。",
    "- 不要用 Markdown 表格（`| … |`）——需要列清单就用「1. 2. 3.」或「- 」这样的纯文本列表。",
    "- 不要用 `[文字](链接)` 语法——直接贴裸 URL。",
    "- 需要强调时，用中文标点或「」引号，别用星号。",
    "",
    "（注意：这条只针对**发到聊天里的回复**。用 `anytype_create_note`/`anytype_insert_markdown`",
    "**写进页面正文**时仍应使用规范 Markdown——页面的块模型需要它。）",
    "",
    "# Memory",
    "",
    "This workspace keeps durable notes in `MEMORY.md` (create it if missing).",
    "Read `MEMORY.md` at the start of a conversation for context.",
    "",
    "## Recording memories",
    "",
    "Record things **proactively** — do not wait to be asked. Whenever you learn",
    "something durable and useful for future conversations, append a concise bullet",
    "to `MEMORY.md`, then briefly confirm what you saved. Worth recording:",
    "- Facts about this workspace, project, server, or people.",
    "- The user's preferences, conventions, and how they like things done.",
    "- Decisions that were made and the reasons behind them.",
    "- Corrections: if the user says a recorded note is wrong, fix or remove it.",
    "",
    "When the user explicitly says \"remember …\", always record it.",
    "Keep each note one short line. Do not record passing small talk, one-off",
    "questions, or anything already captured. Merge/shorten rather than duplicate.",
    "If unsure whether something is durable, record it; the user can ask you to forget.",
    "To forget, delete the relevant line from `MEMORY.md`.",
    "",
  ].join("\n");
  fs.writeFileSync(agentsMd, body, "utf-8");
}
