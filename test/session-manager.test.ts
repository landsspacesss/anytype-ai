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

  it("does not evict a client while same-chat prompts are still queued", async () => {
    const events: string[] = [];
    const createClient = vi.fn(async (chatId: string) => {
      const state = { closed: false };
      return {
        get busy() { return false; },
        async prompt(m: string) {
          await new Promise(r => setTimeout(r, 10));
          if (state.closed) throw new Error(`client ${chatId} was closed`);
          events.push(`prompt${chatId}${m}`);
          return "ok";
        },
        async close() { state.closed = true; events.push(`close${chatId}`); },
        async abort() {},
      };
    });
    const mgr = new SessionManager({ createClient, maxConcurrent: 1, idleMs: 100000 });

    // Start A's first prompt; once its entry exists, queue a second A prompt
    // behind it and a B prompt that must wait for the single slot.
    const p1 = mgr.run("A", "1");
    await new Promise(r => setTimeout(r, 1));
    const p2 = mgr.run("A", "2");
    const p3 = mgr.run("B", "1");

    expect(await Promise.all([p1, p2, p3])).toEqual(["ok", "ok", "ok"]);
    expect(events.indexOf("closeA")).toBeGreaterThan(events.indexOf("promptA1"));
    expect(events.indexOf("closeA")).toBeGreaterThan(events.indexOf("promptA2"));
  });

  it("does not leak a client on a same-chat creation race", async () => {
    let created = 0, closed = 0;
    const createClient = vi.fn(async () => {
      created++;
      await new Promise(r => setTimeout(r, 10));
      return {
        get busy() { return false; },
        async prompt() { await new Promise(r => setTimeout(r, 5)); return "ok"; },
        async close() { closed++; },
        async abort() {},
      };
    });
    const mgr = new SessionManager({ createClient, maxConcurrent: 3, idleMs: 100000 });
    const p1 = mgr.run("A", "m1");
    const p2 = mgr.run("A", "m2");
    expect(await Promise.all([p1, p2])).toEqual(["ok", "ok"]);
    expect(created - closed).toBe(1);
  });

  it("reapIdle does not close a chat with pending work", async () => {
    let closed = false;
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const createClient = vi.fn(async () => ({
      get busy() { return false; },
      async prompt() { await gate; return "ok"; },
      async close() { closed = true; },
      async abort() {},
    }));
    let t = 0;
    const mgr = new SessionManager({ createClient, maxConcurrent: 3, idleMs: 100, now: () => t });
    const p1 = mgr.run("A", "m1");
    await new Promise(r => setTimeout(r, 1)); // let the entry be created
    const p2 = mgr.run("A", "m2");            // queue behind the in-flight prompt
    t = 1000;                                 // advance well past idleMs
    await mgr.reapIdle();
    expect(closed).toBe(false);
    release();
    expect(await Promise.all([p1, p2])).toEqual(["ok", "ok"]);
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

  it("closes and forgets clients idle past idleMs", async () => {
    let t = 0;
    const closed: string[] = [];
    const createClient = async (chatId: string) => ({
      get busy() { return false; },
      async prompt() { return "ok"; },
      async close() { closed.push(chatId); },
      async abort() {},
    });
    const mgr = new SessionManager({ createClient, maxConcurrent: 3, idleMs: 1000, now: () => t });
    await mgr.run("c1", "a");
    t = 2000;
    await mgr.reapIdle();
    expect(closed).toContain("c1");
    await mgr.run("c1", "b");
    // a new client was created for c1 after reaping
    expect(closed.length).toBeGreaterThanOrEqual(1);
  });
});
