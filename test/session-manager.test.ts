import { describe, it, expect, vi } from "vitest";
import { SessionManager } from "../src/session/manager.js";
import type { ApprovalMode } from "../src/agent/approval.js";

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

    // p2 supersedes the in-flight p1 → its reply is muted. p3 is a different chat.
    expect(await Promise.all([p1, p2, p3])).toEqual(["", "ok", "ok"]);
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
    const results = await Promise.all([p1, p2]);
    expect(created - closed).toBe(1);              // no leaked client
    expect([...results].sort()).toEqual(["", "ok"]); // the newer message wins
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
    // p2 superseded the in-flight p1, so p1's reply is muted.
    expect(await Promise.all([p1, p2])).toEqual(["", "ok"]);
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

  it("ensure returns a live client and reuses it", async () => {
    const createClient = vi.fn(async () => fakeClient((m) => `r:${m}`));
    const mgr = new SessionManager({ createClient, maxConcurrent: 3, idleMs: 100000 });
    const c1 = await mgr.ensure("c1");
    const c2 = await mgr.ensure("c1");
    expect(c1).toBe(c2);
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(mgr.get("c1")).toBe(c1);
    expect(mgr.get("nope")).toBeUndefined();
  });

  it("reset forgets the client and makes the next build start fresh once", async () => {
    const seenResume: boolean[] = [];
    const closed: string[] = [];
    let mgr: SessionManager;
    const createClient = vi.fn(async (chatId: string) => {
      seenResume.push(mgr.resumeFor(chatId));
      return {
        get busy() { return false; },
        async prompt() { return "ok"; },
        async close() { closed.push(chatId); },
        async abort() {},
      };
    });
    const clearHistory = vi.fn(async () => {});
    mgr = new SessionManager({ createClient, maxConcurrent: 3, idleMs: 100000, clearHistory });

    await mgr.run("c1", "记住 999");
    expect(mgr.resumeFor("c1")).toBe(true);

    await mgr.reset("c1");
    expect(closed).toContain("c1");
    expect(mgr.get("c1")).toBeUndefined();
    expect(mgr.resumeFor("c1")).toBe(false);
    expect(clearHistory).toHaveBeenCalledWith("c1");

    // The next run must build a fresh client (resume=false), then the flag is
    // consumed so later builds resume normally again.
    await mgr.run("c1", "是多少");
    expect(seenResume).toEqual([true, false]);
    expect(mgr.resumeFor("c1")).toBe(true);
    expect(createClient).toHaveBeenCalledTimes(2);
  });

  it("interrupts the in-flight turn and drops superseded queued turns", async () => {
    const seen: string[] = [];
    let aborted = false;
    let release!: () => void;
    const interrupted = vi.fn();
    const createClient = async () => ({
      get busy() { return true; },
      prompt(m: string) {
        seen.push(m);
        aborted = false;
        return new Promise<string>((resolve) => {
          release = () => resolve(aborted ? "" : `r:${m}`);
        });
      },
      async close() {},
      async abort() {},
      async requestInterrupt() {
        interrupted();
        aborted = true;
        release();
      },
    });
    const mgr = new SessionManager({ createClient, maxConcurrent: 3, idleMs: 1_000_000 });

    const p1 = mgr.run("c", "A"); // A starts and blocks
    await new Promise(r => setTimeout(r, 0));
    const p2 = mgr.run("c", "B"); // interrupts A; B is then superseded
    const p3 = mgr.run("c", "C"); // newest message wins
    await new Promise(r => setTimeout(r, 0));
    release();                    // let C finish

    expect(await p1).toBe("");
    expect(await p2).toBe("");
    expect(await p3).toBe("r:C");
    expect(seen).toEqual(["A", "C"]); // B never reached the model
    expect(interrupted).toHaveBeenCalled();
  });

  it("setInterruptPolicy remembers the policy and applies it to a live client", async () => {
    const setPolicy = vi.fn();
    const requestInterrupt = vi.fn(async () => {});
    const createClient = vi.fn(async () => ({
      get busy() { return false; },
      async prompt() { return "ok"; },
      async close() {},
      async abort() {},
      setInterruptPolicy: setPolicy,
      requestInterrupt,
    }));
    const mgr = new SessionManager({ createClient, maxConcurrent: 3, idleMs: 100000 });
    expect(mgr.getInterruptPolicy("c1")).toBe("step"); // default

    await mgr.ensure("c1"); // spin up a client
    expect(setPolicy).toHaveBeenCalledWith("step");

    await mgr.setInterruptPolicy("c1", "immediate");
    expect(mgr.getInterruptPolicy("c1")).toBe("immediate");
    expect(setPolicy).toHaveBeenLastCalledWith("immediate");
    expect(requestInterrupt).toHaveBeenCalled(); // applied to the running turn

    // A later client rebuild re-adopts the remembered policy.
    await mgr.reset("c1");
    await mgr.ensure("c1");
    expect(setPolicy).toHaveBeenLastCalledWith("immediate");
  });

  it("remembers approval mode per chat and applies it to a live client", async () => {
    const setMode = vi.fn((m: ApprovalMode) => m);
    const approve = vi.fn(() => true);
    const createClient = vi.fn(async () => ({
      get busy() { return false; },
      async prompt() { return "ok"; },
      async close() {}, async abort() {},
      setApprovalMode: setMode, getApprovalMode: () => "auto" as ApprovalMode, approvePending: approve,
    }));
    const mgr = new SessionManager({ createClient, maxConcurrent: 3, idleMs: 100000, defaultApprovalMode: "ask" });
    expect(mgr.getApprovalMode("c1")).toBe("ask"); // default before a client exists
    await mgr.ensure("c1");
    expect(setMode).toHaveBeenCalledWith("ask");   // adopted at creation
    expect(mgr.setApprovalMode("c1", "readonly")).toBe("readonly");
    expect(setMode).toHaveBeenLastCalledWith("readonly");
    expect(mgr.approvePending("c1", "all")).toBe(true);
    expect(approve).toHaveBeenCalledWith("all");
  });

  it("remembers the console lock per chat and applies it to a live client", async () => {
    const setLock = vi.fn((on: boolean) => on);
    const createClient = vi.fn(async () => ({
      get busy() { return false; },
      async prompt() { return "ok"; },
      async close() {}, async abort() {},
      setConsoleUnlocked: setLock, isConsoleUnlocked: () => false,
    }));
    const mgr = new SessionManager({ createClient, maxConcurrent: 3, idleMs: 100000 });
    expect(mgr.getConsoleUnlocked("c1")).toBe(false); // default locked
    await mgr.ensure("c1");
    expect(mgr.setConsoleUnlocked("c1", true)).toBe(true);
    expect(setLock).toHaveBeenLastCalledWith(true);
    expect(mgr.getConsoleUnlocked("c1")).toBe(true);
  });

  it("locking a console records false and survives a rebuild", async () => {
    const setLock = vi.fn((on: boolean) => on);           // returns the resulting state, like the real client
    const createClient = vi.fn(async () => ({
      get busy() { return false; }, async prompt() { return "ok"; }, async close() {}, async abort() {},
      setConsoleUnlocked: setLock, isConsoleUnlocked: () => false,
    }));
    const mgr = new SessionManager({ createClient, maxConcurrent: 3, idleMs: 100000 });
    await mgr.ensure("c1");
    expect(mgr.setConsoleUnlocked("c1", true)).toBe(true);
    expect(mgr.setConsoleUnlocked("c1", false)).toBe(false);   // previously mis-reported true
    expect(mgr.getConsoleUnlocked("c1")).toBe(false);          // lock recorded
    await mgr.reset("c1"); await mgr.ensure("c1");
    expect(setLock).toHaveBeenLastCalledWith(false);           // adopted locked, not resurrected unlocked
  });

  it("refuses (does not record) a lock for a client without the method", async () => {
    const createClient = vi.fn(async () => ({ get busy() { return false; }, async prompt() { return "ok"; }, async close() {}, async abort() {} }));
    const mgr = new SessionManager({ createClient, maxConcurrent: 3, idleMs: 100000 });
    await mgr.ensure("c2");
    expect(mgr.setConsoleUnlocked("c2", true)).toBe(false);
    expect(mgr.getConsoleUnlocked("c2")).toBe(false);
  });
});
