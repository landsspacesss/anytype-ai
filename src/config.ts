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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    apiKey: required(env, "ANYTYPE_API_KEY"),
    apiBaseUrl: required(env, "ANYTYPE_API_BASE_URL"),
    botParticipantId: required(env, "BOT_PARTICIPANT_ID"),
    ompBin: env.OMP_BIN || "omp",
    ompWorkspaceRoot: env.OMP_WORKSPACE_ROOT || "/workspace",
    maxConcurrentSessions: num(env, "MAX_CONCURRENT_SESSIONS", 3),
    idleReapMs: num(env, "IDLE_REAP_MS", 900000),
    replyMaxLen: num(env, "REPLY_MAX_LEN", 4000),
  };
}
