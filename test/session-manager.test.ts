import { describe, it, expect, vi } from "vitest";
import { SessionManager } from "../src/session/manager.js";

function fakeClient(replyFn: (m: string) => string) {
  let busy = false;
  return {
    get busy() { return busy; },
    async prompt(m: string) { busy = true; await new Promise(r => setTimeout(r, 5)); busy = false; return replyFn(m); },
    async close() {},
    async abort() {},
  };
}

describe("SessionManager", () => {
  it("reuses one client per chatId", async () => {
    const createClient = vi.fn(async () => fakeClient((m) => `r:${m}`));
    const mgr = new SessionManager({ createClient, maxConcurrent: 3, idleMs: 100000 });
    expect(await mgr.run("c1", "a")).toBe("r:a");
    expect(await mgr.run("c1", "b")).toBe("r:b");
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it("uses separate clients per chatId", async () => {
    const createClient = vi.fn(async () => fakeClient((m) => `r:${m}`));
    const mgr = new SessionManager({ createClient, maxConcurrent: 3, idleMs: 100000 });
    await mgr.run("c1", "a");
    await mgr.run("c2", "b");
    expect(createClient).toHaveBeenCalledTimes(2);
  });

  it("never exceeds maxConcurrent live clients", async () => {
    let live = 0, peak = 0;
    const createClient = vi.fn(async () => {
      live++; peak = Math.max(peak, live);
      return { get busy() { return false; },
        async prompt() { await new Promise(r => setTimeout(r, 10)); return "ok"; },
        async close() { live--; }, async abort() {} };
    });
    const mgr = new SessionManager({ createClient, maxConcurrent: 2, idleMs: 100000 });
    await Promise.all([mgr.run("a", "1"), mgr.run("b", "2"), mgr.run("c", "3"), mgr.run("d", "4")]);
    expect(peak).toBeLessThanOrEqual(2);
  });
});
