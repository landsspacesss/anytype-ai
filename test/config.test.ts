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
      BOT_IDENTITY: "A7D1kUBFSFfs7jBbTgFZ2uvp2Eo2eSpZWpjt52X41rMqZHPm",
    } as NodeJS.ProcessEnv);
    expect(cfg.botIdentity).toBe("A7D1kUBFSFfs7jBbTgFZ2uvp2Eo2eSpZWpjt52X41rMqZHPm");
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
});
