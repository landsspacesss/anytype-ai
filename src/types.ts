import type { ApprovalMode } from "./agent/approval.js";

export interface ChatTarget {
  spaceId: string;
  chatId: string;
  objectId?: string;
}

export interface NormalizedEvent {
  spaceId: string;
  chatId: string;
  messageId: string;
  senderId: string;
  text: string;
  mentionsBot: boolean;
  isBotSelf: boolean;
  isDirect: boolean;
  objectId?: string;
  /** Extra context prepended to the agent prompt (e.g. "you are in page X's discussion"). */
  contextNote?: string;
  /** Files/images attached to the message (their object ids + kind). */
  attachments?: Array<{ id: string; type: string }>;
}

export interface ChatRow {
  id: string;
  name: string;
}

export interface Member {
  id: string;
  identity: string;
  name?: string;
}

export interface Config {
  apiBaseUrl: string;
  apiKey: string;
  botParticipantId: string;
  botIdentity?: string;
  botDisplayName: string;
  /** Root under which each space gets its own agent workspace directory. */
  agentWorkspaceRoot: string;
  /** Persist each chat's conversation history to disk (env SESSION_PERSIST). Default true. */
  sessionPersist: boolean;
  /** Optional global pi config dir (env PI_AGENT_DIR); unset -> pi's ~/.pi/agent. */
  piAgentDir?: string;
  /** Model id to run the agent with (env PI_MODEL). Default: deepseek-flash (V4.1). */
  piModel: string;
  /** DeepSeek key backing the `web_search` tool (env DEEPSEEK_API_KEY). Default "". */
  searchApiKey: string;
  /** Model for the `web_search` tool (env SEARCH_MODEL). Defaults to piModel. */
  searchModel: string;
  /** Lightpanda binary backing the `web_fetch` tool (env LIGHTPANDA_BIN). Default "lightpanda". */
  webFetchBin: string;
  /** Timeout (ms) for a `web_fetch` run (env WEB_FETCH_TIMEOUT_MS). Default 30000. */
  webFetchTimeoutMs: number;
  /** Max characters returned by `web_fetch` (env WEB_FETCH_MAX_CHARS). Default 20000. */
  webFetchMaxChars: number;
  maxConcurrentSessions: number;
  idleReapMs: number;
  /** Explicit console space id (env CONSOLE_SPACE_ID). Overrides console.json. */
  consoleSpaceId?: string;
  /** Max live named sub-agents per parent session (env MAX_SUBAGENTS). Default 5. */
  maxSubagents: number;
  /** Idle (ms) after which a non-busy named sub-agent is lazily reaped (env SUBAGENT_IDLE_MS). Default 900000. */
  subagentIdleMs: number;
  replyMaxLen: number;
  /** How often the cron scheduler ticks to check which watches are due (env WATCH_TICK_MS). */
  watchTickMs: number;
  /** Default cron for watches that don't specify one (env WATCH_DEFAULT_CRON). */
  watchDefaultCron: string;
  /** Consecutive 404s before a watch is dropped as deleted (env WATCH_MAX_MISSES). */
  watchMaxMisses: number;
  /** Post a self-updating tool-call status message during a turn (env TOOL_STATUS). Default true. */
  toolStatus: boolean;
  /** Delay (ms) before the status placeholder is posted (env TOOL_STATUS_DELAY_MS). Default 1500. */
  toolStatusDelayMs: number;
  /** Pending-approval timeout in ms (env APPROVAL_TIMEOUT_MS). Default 300000; timeout = deny. */
  approvalTimeoutMs: number;
  /** Default approval mode for new (non-console) sessions (env APPROVAL_MODE). Default "auto". */
  approvalMode: ApprovalMode;
  /** Dir holding workflow definitions (env WORKFLOW_DIR). Default /app/workflows. */
  workflowDir: string;
  /** Dir holding per-run state/logs (env WORKFLOW_RUN_DIR). Default <agentWorkspaceRoot>/workflow-runs. */
  workflowRunDir: string;
  /** Chat id for the workflow-status board (env WORKFLOW_STATUS_CHAT). Unset -> no board. */
  workflowStatusChat?: string;
}
