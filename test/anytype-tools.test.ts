import { describe, it, expect, vi } from "vitest";
import { createAnytypeTools } from "../src/agent/anytype-tools.js";
import type { AnytypeClient } from "../src/anytype/client.js";

type ExecResult = { content: Array<{ type: string; text: string }>; details: unknown };

function fakeApi(overrides: Partial<Record<keyof AnytypeClient, unknown>> = {}): AnytypeClient {
  const base = {
    listObjects: vi.fn(async () => [
      { id: "obj1", name: "日常试卷1", type: "page" },
      { id: "obj2", name: "考试大纲", type: "page" },
    ]),
    search: vi.fn(async () => [{ id: "obj1", name: "日常试卷1", type: "page" }]),
    getObjectRaw: vi.fn(async () => ({
      id: "obj1",
      type: "page",
      properties: { name: "日常试卷1" },
      blocks: [
        { id: "b1", type: "text", text: "第一段内容" },
        { id: "b2", type: "image" },
        { id: "b3", type: "text", text: "第二段内容" },
      ],
    })),
    createObject: vi.fn(async () => ({ id: "new-123" })),
  };
  return { ...base, ...overrides } as unknown as AnytypeClient;
}

function toolByName(tools: ReturnType<typeof createAnytypeTools>, name: string) {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

async function run(tool: { execute: (...a: unknown[]) => unknown }, params: unknown): Promise<ExecResult> {
  return (await (tool.execute as Function)("call-1", params, undefined, undefined, {})) as ExecResult;
}

const SPACE = "pqdthe";

describe("createAnytypeTools", () => {
  it("returns the four Anytype tools with expected names", () => {
    const tools = createAnytypeTools({ api: fakeApi(), spaceId: SPACE });
    expect(tools).toHaveLength(4);
    expect(tools.map((t) => t.name)).toEqual([
      "anytype_list_objects",
      "anytype_search",
      "anytype_read_object",
      "anytype_create_note",
    ]);
  });

  it("every tool carries a description, promptSnippet, and identity guidelines", () => {
    const tools = createAnytypeTools({ api: fakeApi(), spaceId: SPACE });
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(0);
      expect(typeof t.promptSnippet).toBe("string");
      expect(t.promptGuidelines?.join(" ")).toMatch(/Anytype space/);
    }
  });

  it("anytype_list_objects calls listObjects(spaceId) and lists name/type/id", async () => {
    const api = fakeApi();
    const tools = createAnytypeTools({ api, spaceId: SPACE });
    const res = await run(toolByName(tools, "anytype_list_objects"), {});
    expect(api.listObjects).toHaveBeenCalledWith(SPACE);
    const text = res.content[0].text;
    expect(text).toContain("日常试卷1");
    expect(text).toContain("考试大纲");
    expect(text).toContain("(page)");
    expect(text).toContain("obj1");
    expect(res.details).toEqual({});
  });

  it("anytype_list_objects honors an optional limit", async () => {
    const api = fakeApi();
    const tools = createAnytypeTools({ api, spaceId: SPACE });
    const res = await run(toolByName(tools, "anytype_list_objects"), { limit: 1 });
    const text = res.content[0].text;
    expect(text).toContain("日常试卷1");
    expect(text).not.toContain("考试大纲");
  });

  it("filters out chats and system objects from list and search", async () => {
    const api = fakeApi({
      listObjects: vi.fn(async () => [
        { id: "p1", name: "日常试卷1", type: "page" },
        { id: "c1", name: "ai-bot-test", type: "chat_derived" },
        { id: "t1", name: "A template", type: "template" },
      ]),
      search: vi.fn(async () => [
        { id: "p1", name: "日常试卷1", type: "page" },
        { id: "c1", name: "ai-bot-test", type: "chat_derived" },
      ]),
    });
    const tools = createAnytypeTools({ api, spaceId: SPACE });
    const listed = await run(toolByName(tools, "anytype_list_objects"), {});
    expect(listed.content[0].text).toContain("日常试卷1");
    expect(listed.content[0].text).not.toContain("ai-bot-test");
    expect(listed.content[0].text).not.toContain("A template");
    const searched = await run(toolByName(tools, "anytype_search"), { query: "x" });
    expect(searched.content[0].text).toContain("日常试卷1");
    expect(searched.content[0].text).not.toContain("ai-bot-test");
  });

  it("anytype_search calls search(spaceId, query) and shows matches", async () => {
    const api = fakeApi();
    const tools = createAnytypeTools({ api, spaceId: SPACE });
    const res = await run(toolByName(tools, "anytype_search"), { query: "日常" });
    expect(api.search).toHaveBeenCalledWith(SPACE, "日常");
    const text = res.content[0].text;
    expect(text).toContain("日常");
    expect(text).toContain("日常试卷1");
    expect(text).toContain("obj1");
  });

  it("anytype_read_object renders the title and block text", async () => {
    const api = fakeApi();
    const tools = createAnytypeTools({ api, spaceId: SPACE });
    const res = await run(toolByName(tools, "anytype_read_object"), { id: "obj1" });
    expect(api.getObjectRaw).toHaveBeenCalledWith(SPACE, "obj1");
    const text = res.content[0].text;
    expect(text).toContain("日常试卷1");
    expect(text).toContain("第一段内容");
    expect(text).toContain("第二段内容");
  });

  it("anytype_create_note passes name/markdown through and returns the new id", async () => {
    const api = fakeApi();
    const tools = createAnytypeTools({ api, spaceId: SPACE });
    const res = await run(toolByName(tools, "anytype_create_note"), { name: "新笔记", markdown: "# 标题" });
    expect(api.createObject).toHaveBeenCalledWith(SPACE, { name: "新笔记", markdown: "# 标题" });
    expect(res.content[0].text).toContain("new-123");
  });

  it("surfaces client failures as text instead of throwing", async () => {
    const api = fakeApi({
      listObjects: vi.fn(async () => {
        throw new Error("listObjects failed: 500");
      }),
    });
    const tools = createAnytypeTools({ api, spaceId: SPACE });
    const res = await run(toolByName(tools, "anytype_list_objects"), {});
    expect(res.content[0].text).toContain("failed");
    expect(res.content[0].text).toContain("500");
  });

  it("describes non-text blocks instead of calling the page empty", async () => {
    const api = fakeApi({
      getObjectRaw: vi.fn(async () => ({
        properties: { name: "日常试卷1" },
        blocks: [{ type: "image" }, { type: "image" }, { type: "image" }, { type: "image" }],
      })),
    });
    const tools = createAnytypeTools({ api, spaceId: SPACE });
    const res = await run(toolByName(tools, "anytype_read_object"), { id: "x" });
    const text = res.content[0].text;
    expect(text).toContain("日常试卷1");
    expect(text).toContain("4× image");
  });

  it("tolerates malformed objects/blocks when reading", async () => {
    const api = fakeApi({
      getObjectRaw: vi.fn(async () => ({ blocks: [null, 42, { text: 7 }, { text: "ok" }] })),
    });
    const tools = createAnytypeTools({ api, spaceId: SPACE });
    const res = await run(toolByName(tools, "anytype_read_object"), { id: "x" });
    const text = res.content[0].text;
    expect(text).toContain("(untitled)");
    expect(text).toContain("ok");
  });
});
