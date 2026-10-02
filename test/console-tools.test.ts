import { describe, it, expect, vi } from "vitest";
import { createAnytypeTools, resolveSpaceId } from "../src/agent/anytype-tools.js";
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
