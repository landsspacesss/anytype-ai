import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("reads required values and applies defaults", () => {
    const cfg = loadConfig({
      ANYTYPE_API_BASE_URL: "http://anytype-cli:31012",
      ANYTYPE_API_KEY: "k",
      BOT_PARTICIPANT_ID: "pid",
    } as NodeJS.ProcessEnv);
    expect(cfg.apiBaseUrl).toBe("http://anytype-cli:31012");
    expect(cfg.apiKey).toBe("k");
    expect(cfg.botParticipantId).toBe("pid");
    expect(cfg.agentWorkspaceRoot).toBe("/workspace");
    expect(cfg.piAgentDir).toBeUndefined();
    expect(cfg.maxConcurrentSessions).toBe(3);
    expect(cfg.idleReapMs).toBe(900000);
    expect(cfg.replyMaxLen).toBe(4000);
    expect(cfg.watchTickMs).toBe(60000);
    expect(cfg.watchDefaultCron).toBe("*/30 * * * *");
    expect(cfg.watchMaxMisses).toBe(3);
  });

  it("reads WATCH_MAX_MISSES and falls back for a non-positive value", () => {
    const custom = loadConfig({
      ANYTYPE_API_BASE_URL: "http://anytype-cli:31012",
      ANYTYPE_API_KEY: "k",
      WATCH_MAX_MISSES: "5",
    } as NodeJS.ProcessEnv);
    expect(custom.watchMaxMisses).toBe(5);

    const bad = loadConfig({
      ANYTYPE_API_BASE_URL: "http://anytype-cli:31012",
      ANYTYPE_API_KEY: "k",
      WATCH_MAX_MISSES: "0",
    } as NodeJS.ProcessEnv);
    expect(bad.watchMaxMisses).toBe(3);
  });

  it("reads WATCH_TICK_MS and falls back for a non-positive value", () => {
    const custom = loadConfig({
      ANYTYPE_API_BASE_URL: "http://anytype-cli:31012",
      ANYTYPE_API_KEY: "k",
      WATCH_TICK_MS: "5000",
    } as NodeJS.ProcessEnv);
    expect(custom.watchTickMs).toBe(5000);

    const bad = loadConfig({
      ANYTYPE_API_BASE_URL: "http://anytype-cli:31012",
      ANYTYPE_API_KEY: "k",
      WATCH_TICK_MS: "0",
    } as NodeJS.ProcessEnv);
    expect(bad.watchTickMs).toBe(60000);
  });

  it("reads WATCH_DEFAULT_CRON and defaults to */30 * * * *", () => {
    const custom = loadConfig({
      ANYTYPE_API_BASE_URL: "http://anytype-cli:31012",
      ANYTYPE_API_KEY: "k",
      WATCH_DEFAULT_CRON: "0 9 * * *",
    } as NodeJS.ProcessEnv);
    expect(custom.watchDefaultCron).toBe("0 9 * * *");

    const dflt = loadConfig({
      ANYTYPE_API_BASE_URL: "http://anytype-cli:31012",
      ANYTYPE_API_KEY: "k",
    } as NodeJS.ProcessEnv);
    expect(dflt.watchDefaultCron).toBe("*/30 * * * *");
  });

  it("defaults and reads MAX_SUBAGENTS / SUBAGENT_IDLE_MS", () => {
    const dflt = loadConfig({
      ANYTYPE_API_BASE_URL: "http://anytype-cli:31012",
      ANYTYPE_API_KEY: "k",
    } as NodeJS.ProcessEnv);
    expect(dflt.maxSubagents).toBe(5);
    expect(dflt.subagentIdleMs).toBe(900000);

    const custom = loadConfig({
      ANYTYPE_API_BASE_URL: "http://anytype-cli:31012",
      ANYTYPE_API_KEY: "k",
      MAX_SUBAGENTS: "8",
      SUBAGENT_IDLE_MS: "120000",
    } as NodeJS.ProcessEnv);
    expect(custom.maxSubagents).toBe(8);
    expect(custom.subagentIdleMs).toBe(120000);

    // Non-positive MAX_SUBAGENTS falls back to the default (posInt).
    const bad = loadConfig({
      ANYTYPE_API_BASE_URL: "http://anytype-cli:31012",
      ANYTYPE_API_KEY: "k",
      MAX_SUBAGENTS: "0",
    } as NodeJS.ProcessEnv);
    expect(bad.maxSubagents).toBe(5);
  });

  it("defaults sessionPersist to true and honors SESSION_PERSIST=false", () => {
    const dflt = loadConfig({
      ANYTYPE_API_BASE_URL: "http://anytype-cli:31012",
      ANYTYPE_API_KEY: "k",
    } as NodeJS.ProcessEnv);
    expect(dflt.sessionPersist).toBe(true);

    const off = loadConfig({
      ANYTYPE_API_BASE_URL: "http://anytype-cli:31012",
      ANYTYPE_API_KEY: "k",
      SESSION_PERSIST: "false",
    } as NodeJS.ProcessEnv);
    expect(off.sessionPersist).toBe(false);

    // Any value other than the literal "false" keeps persistence on.
    const on = loadConfig({
      ANYTYPE_API_BASE_URL: "http://anytype-cli:31012",
      ANYTYPE_API_KEY: "k",
      SESSION_PERSIST: "true",
    } as NodeJS.ProcessEnv);
    expect(on.sessionPersist).toBe(true);
  });

  it("throws when a required value is missing", () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/Missing required env var/);
  });

  it("falls back to defaults for non-positive replyMaxLen and maxConcurrentSessions", () => {
    const cfg = loadConfig({
      ANYTYPE_API_BASE_URL: "http://anytype-cli:31012",
      ANYTYPE_API_KEY: "k",
      BOT_PARTICIPANT_ID: "pid",
      REPLY_MAX_LEN: "0",
      MAX_CONCURRENT_SESSIONS: "-1",
    } as NodeJS.ProcessEnv);
    expect(cfg.replyMaxLen).toBe(4000);
    expect(cfg.maxConcurrentSessions).toBe(3);
  });

  it("reads BOT_IDENTITY and treats BOT_PARTICIPANT_ID as optional", () => {
    const cfg = loadConfig({
      ANYTYPE_API_BASE_URL: "http://anytype-cli:31012",
      ANYTYPE_API_KEY: "k",
      BOT_IDENTITY: "BOTIDENTITY_PLACEHOLDER_xxxxxxxxxxxxxxxxx",
    } as NodeJS.ProcessEnv);
    expect(cfg.botIdentity).toBe("BOTIDENTITY_PLACEHOLDER_xxxxxxxxxxxxxxxxx");
    expect(cfg.botParticipantId).toBe("");
  });

  it("defaults piModel to deepseek-flash (V4.1) and honors PI_MODEL", () => {
    const dflt = loadConfig({
      ANYTYPE_API_BASE_URL: "http://anytype-cli:31012",
      ANYTYPE_API_KEY: "k",
    } as NodeJS.ProcessEnv);
    expect(dflt.piModel).toBe("deepseek-flash");

    const custom = loadConfig({
      ANYTYPE_API_BASE_URL: "http://anytype-cli:31012",
      ANYTYPE_API_KEY: "k",
      PI_MODEL: "deepseek-v4-pro",
    } as NodeJS.ProcessEnv);
    expect(custom.piModel).toBe("deepseek-v4-pro");
  });

  it("defaults searchApiKey to '' and reads DEEPSEEK_API_KEY", () => {
    const dflt = loadConfig({
      ANYTYPE_API_BASE_URL: "http://anytype-cli:31012",
      ANYTYPE_API_KEY: "k",
    } as NodeJS.ProcessEnv);
    expect(dflt.searchApiKey).toBe("");

    const custom = loadConfig({
      ANYTYPE_API_BASE_URL: "http://anytype-cli:31012",
      ANYTYPE_API_KEY: "k",
      DEEPSEEK_API_KEY: "sk-xyz",
    } as NodeJS.ProcessEnv);
    expect(custom.searchApiKey).toBe("sk-xyz");
  });

  it("defaults searchModel to piModel and honors SEARCH_MODEL", () => {
    const dflt = loadConfig({
      ANYTYPE_API_BASE_URL: "http://anytype-cli:31012",
      ANYTYPE_API_KEY: "k",
      PI_MODEL: "deepseek-v4-pro",
    } as NodeJS.ProcessEnv);
    expect(dflt.searchModel).toBe("deepseek-v4-pro");

    const custom = loadConfig({
      ANYTYPE_API_BASE_URL: "http://anytype-cli:31012",
      ANYTYPE_API_KEY: "k",
      PI_MODEL: "deepseek-v4-pro",
      SEARCH_MODEL: "deepseek-flash",
    } as NodeJS.ProcessEnv);
    expect(custom.searchModel).toBe("deepseek-flash");
  });

  it("defaults the web_fetch settings and reads LIGHTPANDA_BIN / WEB_FETCH_*", () => {
    const dflt = loadConfig({
      ANYTYPE_API_BASE_URL: "http://anytype-cli:31012",
      ANYTYPE_API_KEY: "k",
    } as NodeJS.ProcessEnv);
    expect(dflt.webFetchBin).toBe("lightpanda");
    expect(dflt.webFetchTimeoutMs).toBe(30000);
    expect(dflt.webFetchMaxChars).toBe(20000);

    const custom = loadConfig({
      ANYTYPE_API_BASE_URL: "http://anytype-cli:31012",
      ANYTYPE_API_KEY: "k",
      LIGHTPANDA_BIN: "/opt/lp",
      WEB_FETCH_TIMEOUT_MS: "45000",
      WEB_FETCH_MAX_CHARS: "8000",
    } as NodeJS.ProcessEnv);
    expect(custom.webFetchBin).toBe("/opt/lp");
    expect(custom.webFetchTimeoutMs).toBe(45000);
    expect(custom.webFetchMaxChars).toBe(8000);
  });

  it("falls back to web_fetch defaults for non-positive values", () => {
    const cfg = loadConfig({
      ANYTYPE_API_BASE_URL: "http://anytype-cli:31012",
      ANYTYPE_API_KEY: "k",
      WEB_FETCH_TIMEOUT_MS: "0",
      WEB_FETCH_MAX_CHARS: "-5",
    } as NodeJS.ProcessEnv);
    expect(cfg.webFetchTimeoutMs).toBe(30000);
    expect(cfg.webFetchMaxChars).toBe(20000);
  });

  it("reads BOT_DISPLAY_NAME and defaults to anytype-bot", () => {
    const custom = loadConfig({
      ANYTYPE_API_BASE_URL: "http://anytype-cli:31012",
      ANYTYPE_API_KEY: "k",
      BOT_DISPLAY_NAME: "custom",
    } as NodeJS.ProcessEnv);
    expect(custom.botDisplayName).toBe("custom");

    const dflt = loadConfig({
      ANYTYPE_API_BASE_URL: "http://anytype-cli:31012",
      ANYTYPE_API_KEY: "k",
    } as NodeJS.ProcessEnv);
    expect(dflt.botDisplayName).toBe("anytype-bot");
  });

  it("defaults toolStatus to true and honors TOOL_STATUS=false", () => {
    const dflt = loadConfig({
      ANYTYPE_API_BASE_URL: "http://anytype-cli:31012",
      ANYTYPE_API_KEY: "k",
    } as NodeJS.ProcessEnv);
    expect(dflt.toolStatus).toBe(true);

    const off = loadConfig({
      ANYTYPE_API_BASE_URL: "http://anytype-cli:31012",
      ANYTYPE_API_KEY: "k",
      TOOL_STATUS: "false",
    } as NodeJS.ProcessEnv);
    expect(off.toolStatus).toBe(false);

    // Any value other than the literal "false" keeps it on.
    const on = loadConfig({
      ANYTYPE_API_BASE_URL: "http://anytype-cli:31012",
      ANYTYPE_API_KEY: "k",
      TOOL_STATUS: "true",
    } as NodeJS.ProcessEnv);
    expect(on.toolStatus).toBe(true);
  });

  it("defaults toolStatusDelayMs to 1500 and honors an override", () => {
    const dflt = loadConfig({
      ANYTYPE_API_BASE_URL: "http://anytype-cli:31012",
      ANYTYPE_API_KEY: "k",
    } as NodeJS.ProcessEnv);
    expect(dflt.toolStatusDelayMs).toBe(1500);

    const custom = loadConfig({
      ANYTYPE_API_BASE_URL: "http://anytype-cli:31012",
      ANYTYPE_API_KEY: "k",
      TOOL_STATUS_DELAY_MS: "500",
    } as NodeJS.ProcessEnv);
    expect(custom.toolStatusDelayMs).toBe(500);

    // Non-positive falls back to the default.
    const bad = loadConfig({
      ANYTYPE_API_BASE_URL: "http://anytype-cli:31012",
      ANYTYPE_API_KEY: "k",
      TOOL_STATUS_DELAY_MS: "0",
    } as NodeJS.ProcessEnv);
    expect(bad.toolStatusDelayMs).toBe(1500);
  });
});
