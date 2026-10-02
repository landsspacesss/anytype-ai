import type { Config } from "./types.js";

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

function num(env: NodeJS.ProcessEnv, key: string, dflt: number): number {
  const v = env[key];
  if (v === undefined || v === "") return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Env var ${key} must be a number`);
  return n;
}

function posInt(env: NodeJS.ProcessEnv, key: string, dflt: number): number {
  const v = env[key];
  if (v === undefined || v === "") return dflt;
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? n : dflt;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const piModel = env.PI_MODEL || "deepseek-flash";
  return {
    apiKey: required(env, "ANYTYPE_API_KEY"),
    apiBaseUrl: required(env, "ANYTYPE_API_BASE_URL"),
    // The bot's participant id is SPACE-SCOPED (phase0 finding): a single
    // constant is only a fallback when BOT_IDENTITY is not provided. main.ts
    // resolves the real per-space id from listMembers().
    botParticipantId: env.BOT_PARTICIPANT_ID ?? "",
    botIdentity: env.BOT_IDENTITY || undefined,
    botDisplayName: env.BOT_DISPLAY_NAME || "anytype-bot",
    agentWorkspaceRoot: env.AGENT_WORKSPACE_ROOT || "/workspace",
    piAgentDir: env.PI_AGENT_DIR || undefined,
    // DeepSeek V4.1 (`deepseek-flash`) is natively multimodal; see docker/models.json.
    piModel,
    // The `web_search` tool uses DeepSeek's hosted search (same key as the agent).
    // Empty disables the tool with a clear message.
    searchApiKey: env.DEEPSEEK_API_KEY ?? "",
    searchModel: env.SEARCH_MODEL || piModel,
    // The `web_fetch` tool renders pages with the Lightpanda headless browser
    // binary baked into the image; these tune the subprocess call.
    webFetchBin: env.LIGHTPANDA_BIN || "lightpanda",
    webFetchTimeoutMs: posInt(env, "WEB_FETCH_TIMEOUT_MS", 30000),
    webFetchMaxChars: posInt(env, "WEB_FETCH_MAX_CHARS", 20000),
    maxConcurrentSessions: posInt(env, "MAX_CONCURRENT_SESSIONS", 3),
    idleReapMs: num(env, "IDLE_REAP_MS", 900000),
    // Named sub-agents (the `agent` tool): cap live agents per parent session
    // and lazily reap idle ones after this many ms.
    maxSubagents: posInt(env, "MAX_SUBAGENTS", 5),
    subagentIdleMs: num(env, "SUBAGENT_IDLE_MS", 900000),
    replyMaxLen: posInt(env, "REPLY_MAX_LEN", 4000),
    watchTickMs: posInt(env, "WATCH_TICK_MS", 60000),
    watchDefaultCron: env.WATCH_DEFAULT_CRON || "*/30 * * * *",
    // Consecutive 404s before a watched object is treated as deleted (guards
    // against dropping a watch on a transient read failure).
    watchMaxMisses: posInt(env, "WATCH_MAX_MISSES", 3),
  };
}
