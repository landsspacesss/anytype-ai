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
    expect(cfg.ompBin).toBe("omp");
    expect(cfg.maxConcurrentSessions).toBe(3);
    expect(cfg.idleReapMs).toBe(900000);
    expect(cfg.replyMaxLen).toBe(4000);
  });

  it("throws when a required value is missing", () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/ANYTYPE_API_KEY/);
  });
});
