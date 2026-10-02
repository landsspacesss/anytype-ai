import fs from "node:fs";
import path from "node:path";
import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import type { ManagedClient } from "../session/manager.js";
import type { AnytypeClient } from "../anytype/client.js";
import type { WatchStore } from "../watch/store.js";
import { DEFAULT_WATCH_CRON } from "../watch/store.js";
import { createAnytypeTools } from "./anytype-tools.js";

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
}

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
  // Spawn a fresh, isolated session for one self-contained task and return its
  // final text. The child gets the same Anytype tools but NO subagent tool, so
  // it cannot recurse.
  const runSubagent = async (task: string): Promise<string> => {
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
        // NOTE: no runSubagent → the child cannot spawn further sub-agents.
      }),
      ...(model ? { model: model as never } : {}),
    });
    let text = "";
    const unsub = child.subscribe((e) => {
      if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") text += e.assistantMessageEvent.delta;
    });
    try { await child.prompt(task); } finally { unsub(); child.dispose(); }
    return text;
  };

  const { session } = await createAgentSession({
    cwd: opts.cwd,
    agentDir: opts.agentDir,
    authStorage,
    modelRegistry,
    sessionManager: SessionManager.inMemory(),
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
    }),
    ...(model ? { model: model as never } : {}),
  });

  let collected = "";
  const unsubscribe = session.subscribe((e) => {
    if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") {
      collected += e.assistantMessageEvent.delta;
    }
  });

  return {
    get busy(): boolean {
      return session.isStreaming;
    },
    async prompt(m: string): Promise<string> {
      collected = "";
      await session.prompt(m);
      return collected;
    },
    async close(): Promise<void> {
      unsubscribe();
      session.dispose();
    },
    async abort(): Promise<void> {
      await session.abort();
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
