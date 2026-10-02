import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAnytypeTools, resolveSpaceId, collectMemories } from "../src/agent/anytype-tools.js";
import type { AnytypeClient } from "../src/anytype/client.js";
import type { WatchStore } from "../src/watch/store.js";

const SPACES = [
  { id: "spA", name: "考试" },
  { id: "spB", name: "emotions" },
];
function fakeApi(over: Partial<AnytypeClient> = {}): AnytypeClient {
  return {
    listSpaces: vi.fn(async () => SPACES),
    listObjects: vi.fn(async () => []),
    search: vi.fn(async () => []),
    getObjectRaw: vi.fn(async () => null),
    ...over,
  } as unknown as AnytypeClient;
}
function baseDeps(api: AnytypeClient, withConsole?: boolean) {
  return {
    api,
    spaceId: "spA",
    workspaceDir: "/tmp/ws",
    store: { list: () => [] } as unknown as WatchStore,
    chatId: "c1",
    defaultWatchCron: "*/30 * * * *",
    searchApiKey: "",
    ...(withConsole ? { console: { workspaceRoot: "/tmp/ws" } } : {}),
  };
}
function toolNames(tools: { name: string }[]): string[] {
  return tools.map((t) => t.name).sort();
}

describe("resolveSpaceId", () => {
  it("returns the fallback for empty input", async () => {
    expect(await resolveSpaceId(fakeApi(), undefined, "spA")).toBe("spA");
    expect(await resolveSpaceId(fakeApi(), "", "spA")).toBe("spA");
  });

  it("passes through an exact id", async () => {
    expect(await resolveSpaceId(fakeApi(), "spB", "spA")).toBe("spB");
  });

  it("resolves a name to its id", async () => {
    expect(await resolveSpaceId(fakeApi(), "emotions", "spA")).toBe("spB");
  });

  it("falls back on an unknown name", async () => {
    expect(await resolveSpaceId(fakeApi(), "nope", "spA")).toBe("spA");
  });
});

describe("console tool gating", () => {
  it("does NOT expose anytype_list_spaces in a normal session", () => {
    const tools = createAnytypeTools(baseDeps(fakeApi()));
    expect(toolNames(tools)).not.toContain("anytype_list_spaces");
  });

  it("exposes anytype_list_spaces in a console session", () => {
    const tools = createAnytypeTools(baseDeps(fakeApi(), true));
    expect(toolNames(tools)).toContain("anytype_list_spaces");
  });

  it("anytype_list_spaces lists spaces with ids", async () => {
    const tools = createAnytypeTools(baseDeps(fakeApi(), true));
    const t = tools.find((x) => x.name === "anytype_list_spaces")!;
    const res = await t.execute("id", {});
    const text = (res.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("考试");
    expect(text).toContain("spA");
    expect(text).toContain("spB");
  });

  it("anytype_memories is only in console sessions and labels each block", async () => {
    expect(toolNames(createAnytypeTools(baseDeps(fakeApi())))).not.toContain("anytype_memories");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wsroot2-"));
    fs.mkdirSync(path.join(root, "_global"), { recursive: true });
    fs.writeFileSync(path.join(root, "_global", "MEMORY.md"), "hello-global");
    const deps = { ...baseDeps(fakeApi(), false), console: { workspaceRoot: root } };
    const tools = createAnytypeTools(deps);
    const t = tools.find((x) => x.name === "anytype_memories")!;
    const text = ((await t.execute("id", {})).content[0] as { text: string }).text;
    expect(text).toContain("hello-global");
    expect(text).toContain("_global");
  });

  it("anytype_join_space is only in console sessions", async () => {
    expect(toolNames(createAnytypeTools(baseDeps(fakeApi())))).not.toContain("anytype_join_space");
    const joinSpace = vi.fn(async () => ({ ok: true, message: "joined" }));
    const deps = { ...baseDeps(fakeApi(), false), console: { workspaceRoot: "/tmp/ws", joinSpace } };
    const tools = createAnytypeTools(deps);
    const t = tools.find((x) => x.name === "anytype_join_space")!;
    const text = ((await t.execute("id", { link: "https://hi.any.coop/X#Y" })).content[0] as { text: string }).text;
    expect(joinSpace).toHaveBeenCalledWith("https://hi.any.coop/X#Y");
    expect(text).toContain("joined");
  });

  it("anytype_run_in_space registered only with a console runInSpace", () => {
    const noRun = createAnytypeTools(baseDeps(fakeApi(), true)); // console dep w/o runInSpace
    expect(toolNames(noRun)).not.toContain("anytype_run_in_space");

    const runInSpace = vi.fn(async () => "done");
    const deps = { ...baseDeps(fakeApi(), false), console: { workspaceRoot: "/tmp/ws", runInSpace } };
    const tools = createAnytypeTools(deps);
    expect(toolNames(tools)).toContain("anytype_run_in_space");
  });

  it("anytype_run_in_space forwards space + task and returns the result", async () => {
    const runInSpace = vi.fn(async (s: string, t: string) => `ran ${t} in ${s}`);
    const deps = { ...baseDeps(fakeApi(), false), console: { workspaceRoot: "/tmp/ws", runInSpace } };
    const t = createAnytypeTools(deps).find((x) => x.name === "anytype_run_in_space")!;
    const text = ((await t.execute("id", { space: "考试", task: "整理" })).content[0] as { text: string }).text;
    expect(runInSpace).toHaveBeenCalledWith("考试", "整理");
    expect(text).toContain("ran 整理 in 考试");
  });

  it("anytype_run_in_space requires a task", async () => {
    const runInSpace = vi.fn();
    const deps = { ...baseDeps(fakeApi(), false), console: { workspaceRoot: "/tmp/ws", runInSpace } };
    const t = createAnytypeTools(deps).find((x) => x.name === "anytype_run_in_space")!;
    const text = ((await t.execute("id", { space: "x" })).content[0] as { text: string }).text;
    expect(runInSpace).not.toHaveBeenCalled();
    expect(text).toMatch(/task/);
  });
});

describe("collectMemories", () => {
  it("reads _global plus each space dir, skipping dirs without MEMORY.md", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wsroot-"));
    fs.mkdirSync(path.join(root, "_global"), { recursive: true });
    fs.writeFileSync(path.join(root, "_global", "MEMORY.md"), "global note");
    fs.mkdirSync(path.join(root, "spA"), { recursive: true });
    fs.writeFileSync(path.join(root, "spA", "MEMORY.md"), "space A note");
    fs.mkdirSync(path.join(root, "empty"), { recursive: true }); // no MEMORY.md
    const got = collectMemories(root).map((m) => m.spaceId).sort();
    expect(got).toEqual(["_global", "spA"]);
    const g = collectMemories(root).find((m) => m.spaceId === "_global")!;
    expect(g.text).toContain("global note");
  });

  it("returns [] for a missing root", () => {
    expect(collectMemories(path.join(os.tmpdir(), "no-such-root-xyz"))).toEqual([]);
  });
});

describe("cross-space read", () => {
  it("anytype_list_objects honours a `space` id", async () => {
    const listObjects = vi.fn(async (sid: string) => [{ id: `${sid}-1`, name: "n", type: "page" }]);
    const tools = createAnytypeTools(baseDeps(fakeApi({ listObjects } as Partial<AnytypeClient>), true));
    const t = tools.find((x) => x.name === "anytype_list_objects")!;
    await t.execute("id", { space: "spB" });
    expect(listObjects).toHaveBeenCalledWith("spB");
  });

  it("anytype_read_object honours a `space` name", async () => {
    const getObjectRaw = vi.fn(async (sid: string) => ({ id: `${sid}-obj` }));
    const tools = createAnytypeTools(baseDeps(fakeApi({ getObjectRaw } as Partial<AnytypeClient>), true));
    const t = tools.find((x) => x.name === "anytype_read_object")!;
    await t.execute("id", { id: "obj1", space: "emotions" });
    expect(getObjectRaw).toHaveBeenCalledWith("spB", "obj1");
  });

  it("a normal session passes no `space` and stays on its own space", async () => {
    const listObjects = vi.fn(async (sid: string) => []);
    const tools = createAnytypeTools(baseDeps(fakeApi({ listObjects } as Partial<AnytypeClient>)));
    const t = tools.find((x) => x.name === "anytype_list_objects")!;
    await t.execute("id", { space: "spB" }); // param ignored when not console? -> see impl note
    expect(listObjects).toHaveBeenCalledWith("spA");
  });
});
