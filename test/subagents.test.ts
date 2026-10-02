import { describe, it, expect, vi } from "vitest";
import { SubagentRegistry } from "../src/agent/subagents.js";
import type { ChildAgent } from "../src/agent/subagents.js";

/** A fake ChildAgent that records prompts/disposes and can be toggled busy. */
function fakeAgent() {
  let busy = false;
  let disposed = false;
  const prompts: string[] = [];
  const agent: ChildAgent = {
    get busy() {
      return busy;
    },
    async prompt(text: string): Promise<string> {
      prompts.push(text);
      return `echo:${text}`;
    },
    dispose(): void {
      disposed = true;
    },
  };
  return {
    agent,
    prompts,
    isDisposed: () => disposed,
    setBusy: (b: boolean) => {
      busy = b;
    },
  };
}

/** Build a registry whose `create` is tracked; returns the fakes by name. */
function harness(opts: { maxAgents?: number; idleMs?: number; now?: () => number } = {}) {
  const made = new Map<string, ReturnType<typeof fakeAgent>>();
  const create = vi.fn(async (name: string) => {
    const f = fakeAgent();
    made.set(name, f);
    return f.agent;
  });
  const registry = new SubagentRegistry({
    create,
    maxAgents: opts.maxAgents ?? 5,
    idleMs: opts.idleMs ?? 900000,
    now: opts.now,
  });
  return { registry, create, made };
}

describe("SubagentRegistry", () => {
  it("spawn creates one agent and spawn of the same name returns it without recreating", async () => {
    const { registry, create, made } = harness();
    const info = await registry.spawn("counter");
    expect(create).toHaveBeenCalledTimes(1);
    expect(info.name).toBe("counter");
    expect(info.busy).toBe(false);

    const again = await registry.spawn("counter");
    expect(create).toHaveBeenCalledTimes(1);
    expect(again.name).toBe("counter");
    expect(made.get("counter")!.isDisposed()).toBe(false);
    expect(registry.list()).toHaveLength(1);
  });

  it("spawn throws when at the live-agent cap", async () => {
    const { registry, create } = harness({ maxAgents: 1 });
    await registry.spawn("a");
    await expect(registry.spawn("b")).rejects.toThrow("too many sub-agents (max 1)");
    expect(create).toHaveBeenCalledTimes(1);
    // Re-spawning an existing name at the cap is fine (returns it).
    await expect(registry.spawn("a")).resolves.toMatchObject({ name: "a" });
  });

  it("message prompts the right agent and records lastResult", async () => {
    const { registry, made } = harness();
    await registry.spawn("a");
    await registry.spawn("b");
    const reply = await registry.message("b", "remember 7");
    expect(reply).toBe("echo:remember 7");
    expect(made.get("b")!.prompts).toEqual(["remember 7"]);
    expect(made.get("a")!.prompts).toEqual([]);
    expect(registry.list().find((x) => x.name === "b")!.lastResult).toBe("echo:remember 7");
  });

  it("message throws for an unknown name", async () => {
    const { registry } = harness();
    await expect(registry.message("ghost", "hi")).rejects.toThrow('no sub-agent named "ghost"');
  });

  it("list reflects busy state and lastResult", async () => {
    const { registry, made } = harness();
    await registry.spawn("a");
    await registry.message("a", "hi");
    made.get("a")!.setBusy(true);
    const items = registry.list();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ name: "a", busy: true, lastResult: "echo:hi" });
  });

  it("kill disposes and removes one agent; kill of unknown returns false", async () => {
    const { registry, made } = harness();
    await registry.spawn("a");
    expect(registry.kill("a")).toBe(true);
    expect(made.get("a")!.isDisposed()).toBe(true);
    expect(registry.list()).toHaveLength(0);
    expect(registry.kill("a")).toBe(false);
  });

  it("killAll disposes every live agent", async () => {
    const { registry, made } = harness();
    await registry.spawn("a");
    await registry.spawn("b");
    registry.killAll();
    expect(made.get("a")!.isDisposed()).toBe(true);
    expect(made.get("b")!.isDisposed()).toBe(true);
    expect(registry.list()).toHaveLength(0);
  });

  it("lazily reaps a non-busy agent idle past idleMs on the next spawn", async () => {
    let clock = 1000;
    const { registry, made } = harness({ idleMs: 100, now: () => clock });
    await registry.spawn("old");
    clock = 5000; // old is now 4000ms idle > 100ms
    await registry.spawn("fresh"); // triggers reap first
    expect(made.get("old")!.isDisposed()).toBe(true);
    expect(made.get("fresh")!.isDisposed()).toBe(false);
    expect(registry.list().map((x) => x.name)).toEqual(["fresh"]);
  });

  it("never reaps a busy agent even when idle past idleMs", async () => {
    let clock = 1000;
    const { registry, made } = harness({ idleMs: 100, now: () => clock });
    await registry.spawn("busy");
    made.get("busy")!.setBusy(true);
    clock = 5000;
    await registry.message("busy", "still working"); // reap runs but must skip busy
    expect(made.get("busy")!.isDisposed()).toBe(false);
    expect(made.get("busy")!.prompts).toEqual(["still working"]);
  });

  it("reaps on message too, disposing an idle agent that is then recreated on spawn", async () => {
    let clock = 1000;
    const { registry, create, made } = harness({ idleMs: 100, now: () => clock });
    await registry.spawn("a");
    clock = 5000;
    // message to a DIFFERENT live agent triggers the reap.
    await registry.spawn("b");
    await registry.message("b", "x");
    expect(made.get("a")!.isDisposed()).toBe(true);
    clock = 6000;
    await registry.spawn("a"); // recreated because it was reaped
    expect(create).toHaveBeenCalledTimes(3);
  });
});
