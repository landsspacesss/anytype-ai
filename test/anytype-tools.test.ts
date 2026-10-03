import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createAnytypeTools } from "../src/agent/anytype-tools.js";
import type { AnytypeClient } from "../src/anytype/client.js";
import type { WatchStore, WatchRecord } from "../src/watch/store.js";
import type { SubagentRegistry, SubagentInfo } from "../src/agent/subagents.js";

/** A throwaway workspace dir for tool tests. */
function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "anytype-tools-"));
}

type ExecResult = { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details: unknown };

function fakeApi(overrides: Partial<Record<keyof AnytypeClient, unknown>> = {}): AnytypeClient {
  const base = {
    listObjects: vi.fn(async () => [
      { id: "obj1", name: "日常试卷1", type: "page" },
      { id: "obj2", name: "Outline", type: "page" },
    ]),
    listObjectsOfType: vi.fn(async () => [
      { id: "img1", name: "IMG_4127", type: "image" },
      { id: "img2", name: "IMG_4130", type: "image" },
    ]),
    search: vi.fn(async () => [{ id: "obj1", name: "日常试卷1", type: "page" }]),
    filteredSearch: vi.fn(async () => [{ id: "obj1", name: "日常试卷1", type: "page" }]),
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
    downloadFileContent: vi.fn(async () => ({ data: Buffer.from([]), mimeType: "image/jpeg" })),
    patchObject: vi.fn(async () => ({})),
    deleteObject: vi.fn(async () => {}),
    listProperties: vi.fn(async () => [
      { key: "status", name: "Status", format: "select" },
      { key: "tags", name: "Tags", format: "multi_select" },
    ]),
    createProperty: vi.fn(async () => ({ key: "priority" })),
    listTypes: vi.fn(async () => [
      { key: "page", name: "Page" },
      { key: "note", name: "Note" },
    ]),
    createType: vi.fn(async () => ({ key: "plant" })),
    updateType: vi.fn(async () => {}),
    deleteType: vi.fn(async () => {}),
    createCollection: vi.fn(async () => ({ id: "coll-1" })),
    uploadFile: vi.fn(async () => ({ id: "file-1" })),
    sendMessage: vi.fn(async () => {}),
    createChat: vi.fn(async () => ({ id: "chat-new" })),
    reactToMessage: vi.fn(async () => {}),
    editMessage: vi.fn(async () => {}),
    deleteMessage: vi.fn(async () => {}),
    listTemplates: vi.fn(async () => [
      { id: "tpl-1", name: "Weekly Plan", templateFor: "page", isDefault: true },
    ]),
    createTemplate: vi.fn(async () => ({ id: "tpl-new" })),
    deleteTemplate: vi.fn(async () => {}),
  };
  return { ...base, ...overrides } as unknown as AnytypeClient;
}

/** A minimal fake WatchStore for tool tests (records vi.fn calls). */
function fakeStore(): WatchStore & {
  upsert: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  forSpace: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
} {
  return {
    load: vi.fn(),
    all: vi.fn(() => []),
    forSpace: vi.fn(() => []),
    get: vi.fn(),
    upsert: vi.fn(),
    remove: vi.fn(() => true),
    save: vi.fn(),
  } as unknown as WatchStore & {
    upsert: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    forSpace: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
  };
}

function toolByName(tools: ReturnType<typeof createAnytypeTools>, name: string) {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

async function run(tool: { execute: (...a: unknown[]) => unknown }, params: unknown): Promise<ExecResult> {
  return (await (tool.execute as Function)("call-1", params, undefined, undefined, {})) as ExecResult;
}

const SPACE = "sp-abc";
const CHAT = "chat-42";
const DEFAULT_CRON = "*/30 * * * *";

function mkTools(api: AnytypeClient, store: WatchStore = fakeStore(), chatId: string = CHAT) {
  return createAnytypeTools({
    api,
    spaceId: SPACE,
    workspaceDir: tmpWorkspace(),
    store,
    chatId,
    defaultWatchCron: DEFAULT_CRON,
    searchApiKey: "",
  });
}

/** Like mkTools, but with a runSubagent hook so the `subagent` tool is added. */
function mkToolsWithSubagent(
  api: AnytypeClient,
  runSubagent: (task: string) => Promise<string> = async () => "sub-result",
) {
  return createAnytypeTools({
    api,
    spaceId: SPACE,
    workspaceDir: tmpWorkspace(),
    store: fakeStore(),
    chatId: CHAT,
    defaultWatchCron: DEFAULT_CRON,
    searchApiKey: "",
    runSubagent,
  });
}

/** The common required deps (no runSubagent / agentRegistry). */
function baseDeps(api: AnytypeClient, store: WatchStore = fakeStore(), chatId: string = CHAT) {
  return {
    api,
    spaceId: SPACE,
    workspaceDir: tmpWorkspace(),
    store,
    chatId,
    defaultWatchCron: DEFAULT_CRON,
    searchApiKey: "",
  };
}

/** A stub SubagentRegistry that records calls (cast; the shape is what matters). */
function fakeRegistry(
  opts: { items?: SubagentInfo[]; killResult?: boolean; spawnError?: Error } = {},
) {
  const spawn = vi.fn(async (name: string): Promise<SubagentInfo> => {
    if (opts.spawnError) throw opts.spawnError;
    return { name, busy: false, lastUsed: 0 };
  });
  const message = vi.fn(async (_name: string, text: string) => `reply:${text}`);
  const list = vi.fn((): SubagentInfo[] => opts.items ?? []);
  const kill = vi.fn(() => opts.killResult ?? true);
  const registry = { spawn, message, list, kill } as unknown as SubagentRegistry;
  return { registry, spawn, message, list, kill };
}

/** Like mkTools, but with an agentRegistry so the `agent` tool is added. */
function mkToolsWithAgent(api: AnytypeClient, registry: SubagentRegistry) {
  return createAnytypeTools({ ...baseDeps(api), agentRegistry: registry });
}

describe("createAnytypeTools", () => {
  it("returns the thirty-two tools (no subagent) with expected names", () => {
    const tools = mkTools(fakeApi());
    expect(tools).toHaveLength(32);
    expect(tools.map((t) => t.name)).not.toContain("subagent");
    expect(tools.map((t) => t.name)).toEqual([
      "anytype_list_objects",
      "anytype_search",
      "anytype_read_object",
      "anytype_download_images",
      "anytype_download_file",
      "crop_image",
      "anytype_create_note",
      "anytype_update_object",
      "anytype_edit_object",
      "anytype_update_block",
      "anytype_delete_block",
      "anytype_delete_object",
      "anytype_set_property",
      "anytype_list_properties",
      "anytype_create_property",
      "anytype_list_types",
      "anytype_create_type",
      "anytype_update_type",
      "anytype_delete_type",
      "anytype_create_collection",
      "anytype_collection_items",
      "anytype_upload_file",
      "anytype_watch",
      "anytype_send_message",
      "anytype_send_file",
      "anytype_react",
      "anytype_edit_message",
      "anytype_delete_message",
      "anytype_templates",
      "anytype_insert_markdown",
      "web_search",
      "web_fetch",
    ]);
  });

  it("adds a thirty-third `subagent` tool when runSubagent is provided", () => {
    const tools = mkToolsWithSubagent(fakeApi());
    expect(tools).toHaveLength(33);
    const names = tools.map((t) => t.name);
    expect(names).toContain("subagent");
    // The subagent tool is appended after the base 32.
    expect(names[names.length - 1]).toBe("subagent");
  });

  it("subagent calls runSubagent with the task and returns its trimmed text", async () => {
    const runSubagent = vi.fn(async (_task: string) => "  子代理的答案  ");
    const tools = mkToolsWithSubagent(fakeApi(), runSubagent);
    const res = await run(toolByName(tools, "subagent"), { task: "统计 image 数量" });
    expect(runSubagent).toHaveBeenCalledWith("统计 image 数量");
    expect(res.content[0].text).toBe("子代理的答案");
    expect(res.details).toEqual({});
  });

  it("subagent yields a placeholder when the sub-agent returns no text", async () => {
    const tools = mkToolsWithSubagent(fakeApi(), async () => "   ");
    const res = await run(toolByName(tools, "subagent"), { task: "t" });
    expect(res.content[0].text).toBe("(sub-agent returned no text)");
  });

  it("subagent surfaces a failing runSubagent as text instead of throwing", async () => {
    const tools = mkToolsWithSubagent(fakeApi(), async () => {
      throw new Error("boom 500");
    });
    const res = await run(toolByName(tools, "subagent"), { task: "t" });
    expect(res.content[0].text).toContain("subagent failed");
    expect(res.content[0].text).toContain("boom 500");
  });

  it("adds a thirty-fourth `agent` tool when BOTH runSubagent and agentRegistry are provided", () => {
    const tools = createAnytypeTools({
      ...baseDeps(fakeApi()),
      runSubagent: async () => "x",
      agentRegistry: fakeRegistry().registry,
    });
    expect(tools).toHaveLength(34);
    const names = tools.map((t) => t.name);
    expect(names).toContain("agent");
    expect(names[names.length - 1]).toBe("agent");
  });

  it("omits the `agent` tool (count 33) when agentRegistry is absent", () => {
    const tools = mkToolsWithSubagent(fakeApi());
    expect(tools).toHaveLength(33);
    expect(tools.map((t) => t.name)).not.toContain("agent");
  });

  it("agent spawn (no task) creates the named agent and says so", async () => {
    const { registry, spawn } = fakeRegistry();
    const tools = mkToolsWithAgent(fakeApi(), registry);
    const res = await run(toolByName(tools, "agent"), { action: "spawn", name: "counter" });
    expect(spawn).toHaveBeenCalledWith("counter");
    expect(res.content[0].text).toBe("已创建子代理「counter」");
  });

  it("agent spawn with a task immediately messages the agent and returns its reply", async () => {
    const { registry, spawn, message } = fakeRegistry();
    const tools = mkToolsWithAgent(fakeApi(), registry);
    const res = await run(toolByName(tools, "agent"), { action: "spawn", name: "counter", task: "记住7" });
    expect(spawn).toHaveBeenCalledWith("counter");
    expect(message).toHaveBeenCalledWith("counter", "记住7");
    expect(res.content[0].text).toBe("reply:记住7");
  });

  it("agent message returns the named agent's reply", async () => {
    const { registry, message } = fakeRegistry();
    const tools = mkToolsWithAgent(fakeApi(), registry);
    const res = await run(toolByName(tools, "agent"), { action: "message", name: "counter", message: "你记的数字?" });
    expect(message).toHaveBeenCalledWith("counter", "你记的数字?");
    expect(res.content[0].text).toBe("reply:你记的数字?");
  });

  it("agent list renders each agent, and says (no sub-agents) when empty", async () => {
    const empty = fakeRegistry({ items: [] });
    const emptyRes = await run(toolByName(mkToolsWithAgent(fakeApi(), empty.registry), "agent"), { action: "list" });
    expect(emptyRes.content[0].text).toBe("(no sub-agents)");

    const { registry } = fakeRegistry({
      items: [
        { name: "counter", busy: true, lastUsed: 1, lastResult: "7" },
        { name: "worker", busy: false, lastUsed: 2 },
      ],
    });
    const res = await run(toolByName(mkToolsWithAgent(fakeApi(), registry), "agent"), { action: "list" });
    const text = res.content[0].text;
    expect(text).toContain("- counter (busy) — last: 7");
    expect(text).toContain("- worker (idle) — last: ");
  });

  it("agent kill reports whether the agent existed", async () => {
    const { registry, kill } = fakeRegistry({ killResult: true });
    const tools = mkToolsWithAgent(fakeApi(), registry);
    const res = await run(toolByName(tools, "agent"), { action: "kill", name: "counter" });
    expect(kill).toHaveBeenCalledWith("counter");
    expect(res.content[0].text).toBe("已删除子代理「counter」");

    const missing = fakeRegistry({ killResult: false });
    const res2 = await run(toolByName(mkToolsWithAgent(fakeApi(), missing.registry), "agent"), { action: "kill", name: "x" });
    expect(res2.content[0].text).toBe("没有名为「x」的子代理");
  });

  it("agent surfaces registry errors as text instead of throwing", async () => {
    const { registry } = fakeRegistry({ spawnError: new Error("too many sub-agents (max 5)") });
    const tools = mkToolsWithAgent(fakeApi(), registry);
    const res = await run(toolByName(tools, "agent"), { action: "spawn", name: "x" });
    expect(res.content[0].text).toContain("agent failed");
    expect(res.content[0].text).toContain("too many sub-agents (max 5)");
  });

  it("every tool carries a description, promptSnippet, and identity guidelines", () => {
    const tools = mkTools(fakeApi());
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(0);
      expect(typeof t.promptSnippet).toBe("string");
      expect(t.promptGuidelines?.join(" ")).toMatch(/Anytype space/);
    }
  });

  it("anytype_list_objects calls listObjects(spaceId) and lists name/type/id", async () => {
    const api = fakeApi();
    const tools = mkTools(api);
    const res = await run(toolByName(tools, "anytype_list_objects"), {});
    expect(api.listObjects).toHaveBeenCalledWith(SPACE);
    const text = res.content[0].text;
    expect(text).toContain("日常试卷1");
    expect(text).toContain("Outline");
    expect(text).toContain("(page)");
    expect(text).toContain("obj1");
    expect(res.details).toEqual({});
  });

  it("anytype_list_objects with type lists loose objects of that type", async () => {
    const api = fakeApi();
    const tools = mkTools(api);
    const res = await run(toolByName(tools, "anytype_list_objects"), { type: "image" });
    expect(api.listObjectsOfType).toHaveBeenCalledWith(SPACE, "image");
    expect(api.listObjects).not.toHaveBeenCalled();
    const text = res.content[0].text;
    expect(text).toContain("IMG_4127");
    expect(text).toContain("2 image object(s)");
  });

  it("anytype_list_objects honors an optional limit", async () => {
    const api = fakeApi();
    const tools = mkTools(api);
    const res = await run(toolByName(tools, "anytype_list_objects"), { limit: 1 });
    const text = res.content[0].text;
    expect(text).toContain("日常试卷1");
    expect(text).not.toContain("Outline");
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
    const tools = mkTools(api);
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
    const tools = mkTools(api);
    const res = await run(toolByName(tools, "anytype_search"), { query: "日常" });
    expect(api.search).toHaveBeenCalledWith(SPACE, "日常");
    const text = res.content[0].text;
    expect(text).toContain("日常");
    expect(text).toContain("日常试卷1");
    expect(text).toContain("obj1");
  });

  it("anytype_read_object renders the title and block text", async () => {
    const api = fakeApi();
    const tools = mkTools(api);
    const res = await run(toolByName(tools, "anytype_read_object"), { id: "obj1" });
    expect(api.getObjectRaw).toHaveBeenCalledWith(SPACE, "obj1");
    const text = res.content[0].text;
    expect(text).toContain("日常试卷1");
    expect(text).toContain("第一段内容");
    expect(text).toContain("第二段内容");
  });

  it("anytype_create_note passes name/markdown through and returns the new id", async () => {
    const api = fakeApi();
    const tools = mkTools(api);
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
    const tools = mkTools(api);
    const res = await run(toolByName(tools, "anytype_list_objects"), {});
    expect(res.content[0].text).toContain("failed");
    expect(res.content[0].text).toContain("500");
  });

  it("renders image blocks as markdown (not an empty page)", async () => {
    const api = fakeApi({
      getObjectRaw: vi.fn(async () => ({
        properties: { name: "日常试卷1" },
        blocks: [
          { type: "image", object_id: "f1", name: "a.jpg" },
          { type: "image", object_id: "f2", name: "b.jpg" },
        ],
      })),
    });
    const tools = mkTools(api);
    const res = await run(toolByName(tools, "anytype_read_object"), { id: "x" });
    const text = res.content[0].text;
    expect(text).toContain("日常试卷1");
    expect(text).toContain("![a.jpg](f1)");
    expect(text).toContain("![b.jpg](f2)");
    expect((text.match(/!\[/g) || []).length).toBe(2);
  });

  it("attaches page images as image content (downscaled to jpeg)", async () => {
    const sharp = (await import("sharp")).default;
    const png = await sharp({
      create: { width: 4000, height: 100, channels: 3, background: { r: 10, g: 120, b: 200 } },
    })
      .png()
      .toBuffer();
    const api = fakeApi({
      getObjectRaw: vi.fn(async () => ({
        properties: { name: "照片页" },
        blocks: [{ type: "image", object_id: "file-1", mime_type: "image/png" }],
      })),
      downloadFileContent: vi.fn(async () => ({ data: png, mimeType: "image/png" })),
    });
    const tools = mkTools(api);
    const res = await run(toolByName(tools, "anytype_read_object"), { id: "obj1" });
    expect(api.downloadFileContent).toHaveBeenCalledWith(SPACE, "file-1");
    const img = res.content.find((c) => c.type === "image");
    expect(img).toBeTruthy();
    expect(img?.mimeType).toBe("image/jpeg");
    expect((img?.data ?? "").length).toBeGreaterThan(0);
    // downscaled: 4000px wide -> <= 1600, so the base64 is far smaller than the source
    expect((img?.data ?? "").length).toBeLessThan(png.length);
  });

  it("anytype_download_images saves images to the workspace and reports path + dimensions", async () => {
    const png = await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer();
    const api = fakeApi({
      getObjectRaw: vi.fn(async () => ({
        blocks: [{ type: "image", object_id: "f1", mime_type: "image/png", name: "a.png" }],
      })),
      downloadFileContent: vi.fn(async () => ({ data: png, mimeType: "image/png" })),
    });
    const tools = mkTools(api);
    const res = await run(toolByName(tools, "anytype_download_images"), { id: "obj1" });
    const text = res.content[0].text;
    expect(text).toContain("1 image");
    expect(text).toContain("800×600");
    const m = text.match(/(\S+\.png)/);
    expect(m).toBeTruthy();
    if (m) expect(fs.existsSync(m[1])).toBe(true);
  });

  it("anytype_download_file saves a loose file with a mime-derived extension and reports path/mime/size", async () => {
    const pdf = Buffer.from("%PDF-1.4\n% minimal pdf bytes\n");
    const api = fakeApi({
      getObjectRaw: vi.fn(async () => ({ type: "file", properties: { name: "季度报告" } })),
      downloadFileContent: vi.fn(async () => ({ data: pdf, mimeType: "application/pdf" })),
    });
    const tools = mkTools(api);
    const res = await run(toolByName(tools, "anytype_download_file"), { id: "file-abc12345" });
    expect(api.getObjectRaw).toHaveBeenCalledWith(SPACE, "file-abc12345");
    expect(api.downloadFileContent).toHaveBeenCalledWith(SPACE, "file-abc12345");
    const text = res.content[0].text as string;
    expect(text).toContain("Saved to");
    expect(text).toContain("application/pdf");
    expect(text).toContain(`${pdf.length} bytes`);
    const m = text.match(/(\S+\.pdf)/);
    expect(m).toBeTruthy();
    if (m) {
      expect(m[1]).toContain("/files/");
      expect(m[1]).toContain("file-abc"); // id prefix
      expect(fs.existsSync(m[1])).toBe(true);
      expect(fs.readFileSync(m[1]).equals(pdf)).toBe(true);
    }
  });

  it("anytype_download_file falls back to params.name for the filename and maps docx", async () => {
    const docx = Buffer.from("PK fake docx");
    const api = fakeApi({
      getObjectRaw: vi.fn(async () => ({ type: "file", properties: {} })),
      downloadFileContent: vi.fn(async () => ({
        data: docx,
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      })),
    });
    const res = await run(toolByName(mkTools(api), "anytype_download_file"), {
      id: "file-9",
      name: "报告草稿",
    });
    const text = res.content[0].text as string;
    expect(text).toContain(".docx");
    const m = text.match(/(\S+\.docx)/);
    expect(m).toBeTruthy();
    if (m) {
      expect(m[1]).toContain("报告草稿");
      expect(fs.existsSync(m[1])).toBe(true);
    }
  });

  it("anytype_download_file sanitizes separators and defaults unknown types to .bin", async () => {
    const api = fakeApi({
      getObjectRaw: vi.fn(async () => ({ properties: { name: "../../etc/passwd" } })),
      downloadFileContent: vi.fn(async () => ({ data: Buffer.from([0, 1, 2]), mimeType: "application/octet-stream" })),
    });
    const res = await run(toolByName(mkTools(api), "anytype_download_file"), { id: "file-zzzzzzzz" });
    const text = res.content[0].text as string;
    expect(text).toMatch(/\.bin/);
    const m = text.match(/(\S+\.bin)/);
    expect(m).toBeTruthy();
    if (m) {
      expect(fs.existsSync(m[1])).toBe(true);
      // The saved file is a single component inside files/ (no traversal out).
      const rel = m[1].split("/files/")[1] ?? "";
      expect(rel).not.toContain("/");
      expect(rel.length).toBeGreaterThan(0);
    }
  });

  it("anytype_download_file surfaces failures as text instead of throwing", async () => {
    const api = fakeApi({
      getObjectRaw: vi.fn(async () => ({ properties: { name: "x" } })),
      downloadFileContent: vi.fn(async () => {
        throw new Error("downloadFileContent failed: 404");
      }),
    });
    const res = await run(toolByName(mkTools(api), "anytype_download_file"), { id: "gone" });
    expect(res.content[0].text).toContain("anytype_download_file failed");
    expect(res.content[0].text).toContain("404");
  });

  it("crop_image returns image content for a region and refuses paths outside the workspace", async () => {
    const png = await sharp({
      create: { width: 1000, height: 800, channels: 3, background: { r: 9, g: 9, b: 9 } },
    })
      .png()
      .toBuffer();
    const ws = tmpWorkspace();
    const file = path.join(ws, "img.png");
    fs.writeFileSync(file, png);
    const tools = createAnytypeTools({
      api: fakeApi(),
      spaceId: SPACE,
      workspaceDir: ws,
      store: fakeStore(),
      chatId: CHAT,
      defaultWatchCron: DEFAULT_CRON,
    });

    const cropped = await run(toolByName(tools, "crop_image"), { path: file, x: 0, y: 0, width: 0.5, height: 0.5 });
    const img = cropped.content.find((c) => c.type === "image");
    expect(img?.mimeType).toBe("image/jpeg");
    expect((img?.data ?? "").length).toBeGreaterThan(0);

    const refused = await run(toolByName(tools, "crop_image"), { path: "/etc/passwd" });
    expect(refused.content[0].text).toMatch(/refused|no such file/i);
  });

  it("renders blocks as structured Markdown (headings, lists, checkbox, code, indent)", async () => {
    const api = fakeApi({
      getObjectRaw: vi.fn(async () => ({
        properties: { name: "大纲" },
        blocks: [
          { id: "b1", type: "heading_1", text: "标题一" },
          { id: "b2", type: "paragraph", text: "正文" },
          { id: "b3", type: "bulleted_list_item", text: "一级项" },
          { id: "b4", type: "bulleted_list_item", text: "二级项", indent: 1 },
          { id: "b5", type: "checkbox", text: "已完成", checked: true },
          { id: "b6", type: "checkbox", text: "未完成" },
          { id: "b7", type: "code", text: "print(1)", language: "python" },
          { id: "b8", type: "quote", text: "引用" },
          { id: "b9", type: "divider" },
        ],
      })),
    });
    const tools = mkTools(api);
    const res = await run(toolByName(tools, "anytype_read_object"), { id: "x" });
    const t = res.content[0].text;
    expect(t).toContain("# 大纲");
    expect(t).toContain("# 标题一"); // heading_1 block inside the doc
    expect(t).toContain("- 一级项");
    expect(t).toContain("  - 二级项"); // indent preserved
    expect(t).toContain("- [x] 已完成");
    expect(t).toContain("- [ ] 未完成");
    expect(t).toContain("```python");
    expect(t).toContain("> 引用");
    expect(t).toContain("---");
  });

  it("renders the title when properties.name comes back as an array (post-patch shape)", async () => {
    const api = fakeApi({
      getObjectRaw: vi.fn(async () => ({
        properties: { name: ["改过的标题"] },
        blocks: [{ type: "text", text: "正文" }],
      })),
    });
    const tools = mkTools(api);
    const res = await run(toolByName(tools, "anytype_read_object"), { id: "x" });
    const text = res.content[0].text;
    expect(text).toContain("改过的标题");
    expect(text).not.toContain("(untitled)");
  });

  it("attaches an image even when the download reports no image content-type", async () => {
    const png = await sharp({
      create: { width: 40, height: 30, channels: 3, background: { r: 5, g: 90, b: 180 } },
    })
      .png()
      .toBuffer();
    const api = fakeApi({
      getObjectRaw: vi.fn(async () => ({
        type: "image",
        properties: { name: "loose" },
        blocks: [{ type: "image", object_id: "file-1", mime_type: "image/png" }],
      })),
      // A loose file-object's download may report an unknown content-type.
      downloadFileContent: vi.fn(async () => ({ data: png, mimeType: "application/octet-stream" })),
    });
    const tools = mkTools(api);
    const res = await run(toolByName(tools, "anytype_read_object"), { id: "file-1" });
    const img = res.content.find((c) => c.type === "image");
    expect(img).toBeTruthy();
    expect(img?.mimeType).toBe("image/jpeg");
  });

  it("tolerates malformed objects/blocks when reading", async () => {
    const api = fakeApi({
      getObjectRaw: vi.fn(async () => ({ blocks: [null, 42, { text: 7 }, { text: "ok" }] })),
    });
    const tools = mkTools(api);
    const res = await run(toolByName(tools, "anytype_read_object"), { id: "x" });
    const text = res.content[0].text;
    expect(text).toContain("(untitled)");
    expect(text).toContain("ok");
  });

  it("anytype_update_object with name emits a set_properties op", async () => {
    const api = fakeApi();
    const tools = mkTools(api);
    const res = await run(toolByName(tools, "anytype_update_object"), {
      id: "obj1",
      name: "New title",
    });
    expect(api.patchObject).toHaveBeenCalledWith(SPACE, "obj1", [
      { op: "set_properties", set: { name: ["New title"] } },
    ]);
    expect(res.content[0].text).toContain("New title");
  });

  it("anytype_update_object with append_markdown emits an insert_blocks last op", async () => {
    const api = fakeApi();
    const tools = mkTools(api);
    await run(toolByName(tools, "anytype_update_object"), {
      id: "obj1",
      append_markdown: "hello\n- a\n- b",
    });
    expect(api.patchObject).toHaveBeenCalledWith(SPACE, "obj1", [
      { op: "insert_blocks", markdown: "hello\n- a\n- b", position: "last" },
    ]);
  });

  it("anytype_update_object with both emits both ops in order", async () => {
    const api = fakeApi();
    const tools = mkTools(api);
    const res = await run(toolByName(tools, "anytype_update_object"), {
      id: "obj1",
      name: "T2",
      append_markdown: "body",
    });
    expect(api.patchObject).toHaveBeenCalledWith(SPACE, "obj1", [
      { op: "set_properties", set: { name: ["T2"] } },
      { op: "insert_blocks", markdown: "body", position: "last" },
    ]);
    const text = res.content[0].text;
    expect(text).toContain("renamed");
    expect(text).toContain("inserted");
  });

  it("anytype_update_object asks for an argument when neither is given", async () => {
    const api = fakeApi();
    const tools = mkTools(api);
    const res = await run(toolByName(tools, "anytype_update_object"), { id: "obj1" });
    expect(api.patchObject).not.toHaveBeenCalled();
    expect(res.content[0].text).toMatch(/name.*append_markdown|append_markdown.*name/);
  });

  it("anytype_delete_object calls deleteObject(spaceId, id)", async () => {
    const api = fakeApi();
    const tools = mkTools(api);
    const res = await run(toolByName(tools, "anytype_delete_object"), { id: "obj9" });
    expect(api.deleteObject).toHaveBeenCalledWith(SPACE, "obj9");
    expect(res.content[0].text).toContain("obj9");
  });

  it("anytype_set_property emits one set_properties op with the provided buckets", async () => {
    const api = fakeApi();
    const tools = mkTools(api);
    await run(toolByName(tools, "anytype_set_property"), {
      id: "obj1",
      key: "tags",
      set: { status: ["Done"] },
      add: { tags: ["Urgent"] },
      unset: ["due_date"],
    });
    expect(api.patchObject).toHaveBeenCalledWith(SPACE, "obj1", [
      {
        op: "set_properties",
        set: { status: ["Done"] },
        add: { tags: ["Urgent"] },
        unset: ["due_date"],
      },
    ]);
  });

  it("anytype_list_properties renders name (format) — key", async () => {
    const api = fakeApi();
    const tools = mkTools(api);
    const res = await run(toolByName(tools, "anytype_list_properties"), {});
    expect(api.listProperties).toHaveBeenCalledWith(SPACE);
    const text = res.content[0].text;
    expect(text).toContain("Status (select) — status");
    expect(text).toContain("Tags (multi_select) — tags");
  });

  it("anytype_create_property maps option names and returns the key", async () => {
    const api = fakeApi();
    const tools = mkTools(api);
    const res = await run(toolByName(tools, "anytype_create_property"), {
      name: "Priority",
      format: "multi_select",
      options: ["Low", "High"],
    });
    expect(api.createProperty).toHaveBeenCalledWith(SPACE, {
      name: "Priority",
      format: "multi_select",
      options: [{ name: "Low" }, { name: "High" }],
    });
    expect(res.content[0].text).toContain("priority");
  });

  it("anytype_list_types renders name — key", async () => {
    const api = fakeApi();
    const tools = mkTools(api);
    const res = await run(toolByName(tools, "anytype_list_types"), {});
    expect(api.listTypes).toHaveBeenCalledWith(SPACE);
    const text = res.content[0].text;
    expect(text).toContain("Page — page");
    expect(text).toContain("Note — note");
  });

  it("anytype_list_types shows layout when present", async () => {
    const api = fakeApi({
      listTypes: vi.fn(async () => [
        { key: "task", name: "Task", layout: "todo" },
        { key: "page", name: "Page" },
      ]),
    });
    const res = await run(toolByName(mkTools(api), "anytype_list_types"), {});
    const text = res.content[0].text;
    expect(text).toContain("Task (todo) — task");
    expect(text).toContain("Page — page"); // no layout -> no suffix
  });

  it("anytype_create_type maps params and returns the new key", async () => {
    const api = fakeApi();
    const tools = mkTools(api);
    const res = await run(toolByName(tools, "anytype_create_type"), {
      name: "Plant",
      plural_name: "Plants",
      layout: "basic",
      icon_emoji: "🌱",
      properties: ["Location", "Watered"],
    });
    expect(api.createType).toHaveBeenCalledWith(SPACE, {
      name: "Plant",
      pluralName: "Plants",
      layout: "basic",
      iconEmoji: "🌱",
      properties: ["Location", "Watered"],
    });
    expect(res.content[0].text).toContain("已创建类型「Plant」");
    expect(res.content[0].text).toContain("plant");
  });

  it("anytype_create_type works with only a name", async () => {
    const api = fakeApi();
    await run(toolByName(mkTools(api), "anytype_create_type"), { name: "Solo" });
    expect(api.createType).toHaveBeenCalledWith(SPACE, {
      name: "Solo",
      pluralName: undefined,
      layout: undefined,
      iconEmoji: undefined,
      properties: undefined,
    });
  });

  it("anytype_create_type surfaces a failure as text", async () => {
    const api = fakeApi({
      createType: vi.fn(async () => {
        throw new Error("createType failed: 400");
      }),
    });
    const res = await run(toolByName(mkTools(api), "anytype_create_type"), { name: "X" });
    expect(res.content[0].text).toContain("anytype_create_type failed");
    expect(res.content[0].text).toContain("400");
  });

  it("anytype_update_type maps params and calls updateType", async () => {
    const api = fakeApi();
    const tools = mkTools(api);
    const res = await run(toolByName(tools, "anytype_update_type"), {
      key: "plant",
      name: "Flower",
      default_view: "gallery",
    });
    expect(api.updateType).toHaveBeenCalledWith(SPACE, "plant", {
      name: "Flower",
      pluralName: undefined,
      layout: undefined,
      iconEmoji: undefined,
      defaultView: "gallery",
    });
    expect(res.content[0].text).toContain("已更新类型 plant");
  });

  it("anytype_update_type requires at least one field to change", async () => {
    const api = fakeApi();
    const res = await run(toolByName(mkTools(api), "anytype_update_type"), { key: "plant" });
    expect(api.updateType).not.toHaveBeenCalled();
    expect(res.content[0].text).toMatch(/at least one/);
  });

  it("anytype_update_type surfaces a failure as text", async () => {
    const api = fakeApi({
      updateType: vi.fn(async () => {
        throw new Error("updateType failed: 404");
      }),
    });
    const res = await run(toolByName(mkTools(api), "anytype_update_type"), { key: "gone", name: "x" });
    expect(res.content[0].text).toContain("anytype_update_type failed");
    expect(res.content[0].text).toContain("404");
  });

  it("anytype_delete_type calls deleteType(spaceId, key)", async () => {
    const api = fakeApi();
    const res = await run(toolByName(mkTools(api), "anytype_delete_type"), { key: "plant" });
    expect(api.deleteType).toHaveBeenCalledWith(SPACE, "plant");
    expect(res.content[0].text).toContain("已删除类型 plant");
  });

  it("anytype_delete_type surfaces a failure as text", async () => {
    const api = fakeApi({
      deleteType: vi.fn(async () => {
        throw new Error("deleteType failed: 403");
      }),
    });
    const res = await run(toolByName(mkTools(api), "anytype_delete_type"), { key: "plant" });
    expect(res.content[0].text).toContain("anytype_delete_type failed");
    expect(res.content[0].text).toContain("403");
  });

  it("anytype_create_collection passes name/items and returns the id", async () => {
    const api = fakeApi();
    const tools = mkTools(api);
    const res = await run(toolByName(tools, "anytype_create_collection"), {
      name: "Reading",
      items: ["obj1", "obj2"],
    });
    expect(api.createCollection).toHaveBeenCalledWith(SPACE, {
      name: "Reading",
      items: ["obj1", "obj2"],
    });
    expect(res.content[0].text).toContain("coll-1");
  });

  it("anytype_upload_file forwards url/path/name and returns the id", async () => {
    const api = fakeApi();
    const tools = mkTools(api);
    const res = await run(toolByName(tools, "anytype_upload_file"), {
      url: "https://example.com/a.png",
      name: "a.png",
    });
    expect(api.uploadFile).toHaveBeenCalledWith(SPACE, {
      url: "https://example.com/a.png",
      path: undefined,
      name: "a.png",
    });
    expect(res.content[0].text).toContain("file-1");
  });

  it("anytype_upload_file asks for url or path when neither is given", async () => {
    const api = fakeApi();
    const tools = mkTools(api);
    const res = await run(toolByName(tools, "anytype_upload_file"), {});
    expect(api.uploadFile).not.toHaveBeenCalled();
    expect(res.content[0].text).toMatch(/url.*path|path.*url/);
  });

  it("surfaces failures of the new tools as text instead of throwing", async () => {
    const api = fakeApi({
      deleteObject: vi.fn(async () => {
        throw new Error("deleteObject failed: 403");
      }),
    });
    const tools = mkTools(api);
    const res = await run(toolByName(tools, "anytype_delete_object"), { id: "x" });
    expect(res.content[0].text).toContain("anytype_delete_object failed");
    expect(res.content[0].text).toContain("403");
  });

  it("anytype_edit_object emits one replace_text op", async () => {
    const api = fakeApi();
    const tools = mkTools(api);
    const res = await run(toolByName(tools, "anytype_edit_object"), {
      id: "obj1",
      find: "Q3",
      replace: "Q4",
    });
    expect(api.patchObject).toHaveBeenCalledWith(SPACE, "obj1", [
      { op: "replace_text", find: "Q3", replace: "Q4" },
    ]);
    expect(res.content[0].text).toContain("Q3");
    expect(res.content[0].text).toContain("Q4");
  });

  it("anytype_edit_object passes replace_all through when given", async () => {
    const api = fakeApi();
    const tools = mkTools(api);
    await run(toolByName(tools, "anytype_edit_object"), {
      id: "obj1",
      find: "Q3",
      replace: "Q4",
      replace_all: true,
    });
    expect(api.patchObject).toHaveBeenCalledWith(SPACE, "obj1", [
      { op: "replace_text", find: "Q3", replace: "Q4", replace_all: true },
    ]);
  });

  it("anytype_update_block emits an update_block op located by match", async () => {
    const api = fakeApi();
    const tools = mkTools(api);
    const res = await run(toolByName(tools, "anytype_update_block"), {
      id: "obj1",
      match: "Draft timeline",
      set: { checked: true },
    });
    expect(api.patchObject).toHaveBeenCalledWith(SPACE, "obj1", [
      { op: "update_block", match: "Draft timeline", set: { checked: true } },
    ]);
    expect(res.content[0].text).toContain("Draft timeline");
  });

  it("anytype_update_block locates by block_id and requires a target", async () => {
    const api = fakeApi();
    const tools = mkTools(api);
    await run(toolByName(tools, "anytype_update_block"), {
      id: "obj1",
      block_id: "b7",
      set: { text: "new" },
    });
    expect(api.patchObject).toHaveBeenCalledWith(SPACE, "obj1", [
      { op: "update_block", id: "b7", set: { text: "new" } },
    ]);
    const api2 = fakeApi();
    const res = await run(toolByName(mkTools(api2), "anytype_update_block"), {
      id: "obj1",
      set: { checked: true },
    });
    expect(api2.patchObject).not.toHaveBeenCalled();
    expect(res.content[0].text).toMatch(/match.*block_id|block_id.*match/);
  });

  it("anytype_delete_block emits a delete_block op with recursive", async () => {
    const api = fakeApi();
    const tools = mkTools(api);
    const res = await run(toolByName(tools, "anytype_delete_block"), {
      id: "obj1",
      match: "Obsolete section",
      recursive: true,
    });
    expect(api.patchObject).toHaveBeenCalledWith(SPACE, "obj1", [
      { op: "delete_block", match: "Obsolete section", recursive: true },
    ]);
    expect(res.content[0].text).toContain("Obsolete section");
  });

  it("anytype_delete_block asks for a target when neither match nor block_id is given", async () => {
    const api = fakeApi();
    const res = await run(toolByName(mkTools(api), "anytype_delete_block"), { id: "obj1" });
    expect(api.patchObject).not.toHaveBeenCalled();
    expect(res.content[0].text).toMatch(/match.*block_id|block_id.*match/);
  });

  it("anytype_collection_items emits add_items and remove_items ops", async () => {
    const api = fakeApi();
    const tools = mkTools(api);
    const res = await run(toolByName(tools, "anytype_collection_items"), {
      collection_id: "coll-1",
      add: ["obj1", "obj2"],
      remove: ["obj3"],
    });
    expect(api.patchObject).toHaveBeenCalledWith(SPACE, "coll-1", [
      { op: "add_items", items: ["obj1", "obj2"] },
      { op: "remove_items", items: ["obj3"] },
    ]);
    expect(res.content[0].text).toContain("added 2");
    expect(res.content[0].text).toContain("removed 1");
  });

  it("anytype_collection_items with only add emits a single add_items op", async () => {
    const api = fakeApi();
    await run(toolByName(mkTools(api), "anytype_collection_items"), {
      collection_id: "coll-1",
      add: ["obj1"],
    });
    expect(api.patchObject).toHaveBeenCalledWith(SPACE, "coll-1", [
      { op: "add_items", items: ["obj1"] },
    ]);
  });

  it("anytype_collection_items asks for add or remove when neither is given", async () => {
    const api = fakeApi();
    const res = await run(toolByName(mkTools(api), "anytype_collection_items"), {
      collection_id: "coll-1",
    });
    expect(api.patchObject).not.toHaveBeenCalled();
    expect(res.content[0].text).toMatch(/add.*remove|remove.*add/);
  });

  it("anytype_search passes filters through to filteredSearch", async () => {
    const api = fakeApi();
    const tools = mkTools(api);
    const filters = [{ condition: "in", property: "tag", value: ["重要"] }];
    const res = await run(toolByName(tools, "anytype_search"), { filters });
    expect(api.filteredSearch).toHaveBeenCalledWith(SPACE, { query: "", filters });
    expect(api.search).not.toHaveBeenCalled();
    const text = res.content[0].text;
    expect(text).toContain("日常试卷1");
    expect(text).toContain("obj1");
  });

  it("anytype_search passes query alongside filters when both are given", async () => {
    const api = fakeApi();
    const filters = [{ condition: "contains", property: "name", value: "x" }];
    await run(toolByName(mkTools(api), "anytype_search"), { query: "日常", filters });
    expect(api.filteredSearch).toHaveBeenCalledWith(SPACE, { query: "日常", filters });
  });

  it("anytype_search with query only still uses search (back-compat)", async () => {
    const api = fakeApi();
    await run(toolByName(mkTools(api), "anytype_search"), { query: "日常" });
    expect(api.search).toHaveBeenCalledWith(SPACE, "日常");
    expect(api.filteredSearch).not.toHaveBeenCalled();
  });

  it("anytype_search asks for query or filters when neither is given", async () => {
    const api = fakeApi();
    const res = await run(toolByName(mkTools(api), "anytype_search"), {});
    expect(api.search).not.toHaveBeenCalled();
    expect(api.filteredSearch).not.toHaveBeenCalled();
    expect(res.content[0].text).toMatch(/query.*filters|filters.*query/);
  });

  it("anytype_watch add baselines a snapshot and records chatId + spaceId", async () => {
    const api = fakeApi();
    const store = fakeStore();
    const res = await run(toolByName(mkTools(api, store), "anytype_watch"), { action: "add", id: "obj1" });
    expect(api.getObjectRaw).toHaveBeenCalledWith(SPACE, "obj1");
    expect(store.upsert).toHaveBeenCalledTimes(1);
    const rec = store.upsert.mock.calls[0][0] as WatchRecord;
    expect(rec).toEqual({
      objectId: "obj1",
      spaceId: SPACE,
      chatId: CHAT,
      label: "日常试卷1",
      snapshot: [
        { id: "b1", text: "第一段内容" },
        { id: "b2", text: "" },
        { id: "b3", text: "第二段内容" },
      ],
      cron: DEFAULT_CRON,
      source: { kind: "object", id: "obj1" },
    });
    expect(store.save).toHaveBeenCalled();
    expect(res.content[0].text).toContain("已订阅");
    expect(res.content[0].text).toContain("日常试卷1");
    expect(res.content[0].text).toContain("每 30 分钟");
  });

  it("anytype_watch add stores an explicit cron", async () => {
    const store = fakeStore();
    const res = await run(toolByName(mkTools(fakeApi(), store), "anytype_watch"), {
      action: "add",
      id: "obj1",
      cron: "0 9 * * 1-5",
    });
    expect((store.upsert.mock.calls[0][0] as WatchRecord).cron).toBe("0 9 * * 1-5");
    expect(res.content[0].text).toContain("工作日 09:00");
  });

  it("anytype_watch add stores a custom prompt and mentions it in the reply", async () => {
    const store = fakeStore();
    const res = await run(toolByName(mkTools(fakeApi(), store), "anytype_watch"), {
      action: "add",
      id: "obj1",
      prompt: "总结这篇文章的变化",
    });
    expect((store.upsert.mock.calls[0][0] as WatchRecord).prompt).toBe("总结这篇文章的变化");
    expect(res.content[0].text).toContain("总结这篇文章的变化");
  });

  it("anytype_watch add omits a blank prompt", async () => {
    const store = fakeStore();
    await run(toolByName(mkTools(fakeApi(), store), "anytype_watch"), {
      action: "add",
      id: "obj1",
      prompt: "   ",
    });
    expect((store.upsert.mock.calls[0][0] as WatchRecord).prompt).toBeUndefined();
  });

  it("anytype_watch add with no prompt keeps the record prompt-free", async () => {
    const store = fakeStore();
    await run(toolByName(mkTools(fakeApi(), store), "anytype_watch"), { action: "add", id: "obj1" });
    expect("prompt" in (store.upsert.mock.calls[0][0] as WatchRecord)).toBe(false);
  });

  it("anytype_watch add rejects an invalid cron", async () => {
    const store = fakeStore();
    const res = await run(toolByName(mkTools(fakeApi(), store), "anytype_watch"), {
      action: "add",
      id: "obj1",
      cron: "not a cron",
    });
    expect(store.upsert).not.toHaveBeenCalled();
    expect(res.content[0].text).toContain("cron 表达式无效");
  });

  it("anytype_watch schedule updates the cron and resets lastFiredMinute", async () => {
    const store = fakeStore();
    const record: WatchRecord = {
      objectId: "obj1",
      spaceId: SPACE,
      chatId: CHAT,
      label: "日常试卷1",
      snapshot: [],
      cron: DEFAULT_CRON,
      lastFiredMinute: "2026-10-02T09:00",
    };
    store.get = vi.fn(() => record);
    const res = await run(toolByName(mkTools(fakeApi(), store), "anytype_watch"), {
      action: "schedule",
      id: "obj1",
      cron: "0 9 * * *",
    });
    expect(record.cron).toBe("0 9 * * *");
    expect(record.lastFiredMinute).toBeUndefined();
    expect(store.save).toHaveBeenCalled();
    expect(res.content[0].text).toContain("每天 09:00");
  });

  it("anytype_watch schedule updates the prompt without touching cron", async () => {
    const store = fakeStore();
    const record: WatchRecord = {
      objectId: "obj1",
      spaceId: SPACE,
      chatId: CHAT,
      label: "日常试卷1",
      snapshot: [],
      cron: DEFAULT_CRON,
      lastFiredMinute: "2026-10-02T09:00",
    };
    store.get = vi.fn(() => record);
    const res = await run(toolByName(mkTools(fakeApi(), store), "anytype_watch"), {
      action: "schedule",
      id: "obj1",
      prompt: "检查未完成待办并提醒我",
    });
    expect(record.prompt).toBe("检查未完成待办并提醒我");
    expect(record.cron).toBe(DEFAULT_CRON);
    expect(record.lastFiredMinute).toBe("2026-10-02T09:00"); // untouched: no cron change
    expect(store.save).toHaveBeenCalled();
    expect(res.content[0].text).toContain("检查未完成待办并提醒我");
  });

  it("anytype_watch schedule updates cron and prompt together", async () => {
    const store = fakeStore();
    const record: WatchRecord = {
      objectId: "obj1",
      spaceId: SPACE,
      chatId: CHAT,
      label: "日常试卷1",
      snapshot: [],
      cron: DEFAULT_CRON,
    };
    store.get = vi.fn(() => record);
    const res = await run(toolByName(mkTools(fakeApi(), store), "anytype_watch"), {
      action: "schedule",
      id: "obj1",
      cron: "0 9 * * *",
      prompt: "总结变化",
    });
    expect(record.cron).toBe("0 9 * * *");
    expect(record.prompt).toBe("总结变化");
    const text = res.content[0].text;
    expect(text).toContain("每天 09:00");
    expect(text).toContain("总结变化");
  });

  it("anytype_watch schedule clears the prompt with a blank value", async () => {
    const store = fakeStore();
    const record: WatchRecord = {
      objectId: "obj1",
      spaceId: SPACE,
      chatId: CHAT,
      label: "日常试卷1",
      snapshot: [],
      cron: DEFAULT_CRON,
      prompt: "旧的指令",
    };
    store.get = vi.fn(() => record);
    const res = await run(toolByName(mkTools(fakeApi(), store), "anytype_watch"), {
      action: "schedule",
      id: "obj1",
      prompt: "  ",
    });
    expect(record.prompt).toBeUndefined();
    expect(res.content[0].text).toContain("已清除变化指令");
  });

  it("anytype_watch schedule requires id and at least one of cron/prompt, and rejects invalid cron", async () => {
    const store = fakeStore();
    const noId = await run(toolByName(mkTools(fakeApi(), store), "anytype_watch"), {
      action: "schedule",
      cron: "0 9 * * *",
    });
    expect(noId.content[0].text).toMatch(/id/);

    const noCron = await run(toolByName(mkTools(fakeApi(), store), "anytype_watch"), {
      action: "schedule",
      id: "obj1",
    });
    expect(noCron.content[0].text).toMatch(/cron/);

    store.get = vi.fn(() => undefined);
    const bad = await run(toolByName(mkTools(fakeApi(), store), "anytype_watch"), {
      action: "schedule",
      id: "obj1",
      cron: "99 * * * *",
    });
    expect(bad.content[0].text).toContain("cron 表达式无效");
  });

  it("anytype_watch check polls now and reports a change", async () => {
    const store = fakeStore();
    const record: WatchRecord = {
      objectId: "obj1",
      spaceId: SPACE,
      chatId: CHAT,
      label: "日常试卷1",
      snapshot: [{ id: "b1", text: "旧内容" }],
      cron: DEFAULT_CRON,
    };
    store.get = vi.fn(() => record);
    const api = fakeApi();
    const res = await run(toolByName(mkTools(api, store), "anytype_watch"), {
      action: "check",
      id: "obj1",
    });
    // `check` is synchronous: it must NOT post via the dispatcher/sendMessage.
    expect(api.sendMessage).not.toHaveBeenCalled();
    const text = res.content[0].text;
    expect(text).toContain("内容有更新");
    expect(text).toContain("订阅的对象"); // the captured diff summary is surfaced
  });

  it("anytype_watch check reports no change when the snapshot matches", async () => {
    const store = fakeStore();
    const record: WatchRecord = {
      objectId: "obj1",
      spaceId: SPACE,
      chatId: CHAT,
      label: "日常试卷1",
      snapshot: [
        { id: "b1", text: "第一段内容" },
        { id: "b2", text: "" },
        { id: "b3", text: "第二段内容" },
      ],
      cron: DEFAULT_CRON,
    };
    store.get = vi.fn(() => record);
    const res = await run(toolByName(mkTools(fakeApi(), store), "anytype_watch"), {
      action: "check",
      id: "obj1",
    });
    expect(res.content[0].text).toContain("内容没有变化");
  });

  it("anytype_watch add honors an explicit label", async () => {
    const store = fakeStore();
    await run(toolByName(mkTools(fakeApi(), store), "anytype_watch"), {
      action: "add",
      id: "obj1",
      label: "我的订阅",
    });
    expect((store.upsert.mock.calls[0][0] as WatchRecord).label).toBe("我的订阅");
  });

  it("anytype_watch add requires an id", async () => {
    const store = fakeStore();
    const res = await run(toolByName(mkTools(fakeApi(), store), "anytype_watch"), { action: "add" });
    expect(store.upsert).not.toHaveBeenCalled();
    expect(res.content[0].text).toMatch(/id/);
  });

  it("anytype_watch remove unsubscribes and saves", async () => {
    const store = fakeStore();
    const res = await run(toolByName(mkTools(fakeApi(), store), "anytype_watch"), {
      action: "remove",
      id: "obj1",
    });
    expect(store.remove).toHaveBeenCalledWith(SPACE, "obj1");
    expect(store.save).toHaveBeenCalled();
    expect(res.content[0].text).toContain("已取消订阅");
  });

  it("anytype_watch remove reports when nothing was subscribed", async () => {
    const store = fakeStore();
    store.remove = vi.fn(() => false);
    const res = await run(toolByName(mkTools(fakeApi(), store), "anytype_watch"), {
      action: "remove",
      id: "nope",
    });
    expect(store.save).not.toHaveBeenCalled();
    expect(res.content[0].text).toContain("没有找到");
  });

  it("anytype_watch list renders label + schedule + id", async () => {
    const store = fakeStore();
    store.forSpace = vi.fn(() => [
      { objectId: "obj1", spaceId: SPACE, chatId: CHAT, label: "日常试卷1", snapshot: [], cron: "0 9 * * *" },
    ]);
    const res = await run(toolByName(mkTools(fakeApi(), store), "anytype_watch"), { action: "list" });
    expect(store.forSpace).toHaveBeenCalledWith(SPACE);
    const text = res.content[0].text;
    expect(text).toContain("日常试卷1");
    expect(text).toContain("obj1");
    expect(text).toContain("每天 09:00");
  });

  it("anytype_watch list shows whether a prompt is set (truncated to 30 chars)", async () => {
    const store = fakeStore();
    const longPrompt = "请总结这篇长文章的变化，列出所有要点，并标注每条要点的来源段落";
    store.forSpace = vi.fn(() => [
      { objectId: "with", spaceId: SPACE, chatId: CHAT, label: "带提示", snapshot: [], cron: "0 9 * * *", prompt: longPrompt },
      { objectId: "without", spaceId: SPACE, chatId: CHAT, label: "普通订阅", snapshot: [], cron: "0 9 * * *" },
    ]);
    const res = await run(toolByName(mkTools(fakeApi(), store), "anytype_watch"), { action: "list" });
    const text = res.content[0].text;
    expect(text).toContain(`指令：${longPrompt.slice(0, 30)}…`);
    expect(text).not.toContain(`指令：${longPrompt}`);
    const withoutLine = text.split("\n").find((l) => l.includes("普通订阅")) ?? "";
    expect(withoutLine).not.toContain("指令");
  });

  it("anytype_watch list reports an empty subscription set", async () => {
    const res = await run(toolByName(mkTools(fakeApi(), fakeStore()), "anytype_watch"), { action: "list" });
    expect(res.content[0].text).toContain("没有任何订阅");
  });

  it("anytype_watch surfaces client failures as text instead of throwing", async () => {
    const api = fakeApi({
      getObjectRaw: vi.fn(async () => {
        throw new Error("getObjectRaw failed: 404");
      }),
    });
    const res = await run(toolByName(mkTools(api), "anytype_watch"), { action: "add", id: "gone" });
    expect(res.content[0].text).toContain("anytype_watch failed");
    expect(res.content[0].text).toContain("404");
  });

  // --- chat operations -----------------------------------------------------

  it("anytype_watch add with filters creates a query subscription", async () => {
    const api = fakeApi();
    const store = fakeStore();
    const res = await run(toolByName(mkTools(api, store), "anytype_watch"), {
      action: "add",
      filters: [{ condition: "in", property: "tag", value: ["重要"] }],
    });
    expect(res.content[0].text).toContain("已订阅");
    const rec = (store.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(rec.source).toEqual({ kind: "query", filters: [{ condition: "in", property: "tag", value: ["重要"] }] });
    expect(String(rec.objectId).startsWith("query:")).toBe(true);
    expect(api.filteredSearch).toHaveBeenCalled();
  });

  it("anytype_watch add with id + blocks restricts to those blocks", async () => {
    const api = fakeApi();
    const store = fakeStore();
    const res = await run(toolByName(mkTools(api, store), "anytype_watch"), {
      action: "add",
      id: "obj1",
      blocks: ["b1"],
    });
    expect(res.content[0].text).toContain("块");
    const rec = (store.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(rec.source).toEqual({ kind: "blocks", id: "obj1", blockIds: ["b1"] });
    expect(rec.objectId).toBe("obj1");
    expect(rec.snapshot.every((s: { id: string }) => s.id === "b1")).toBe(true);
  });

  it("anytype_send_message sends to the CURRENT chat with an idempotency key", async () => {
    const api = fakeApi();
    const res = await run(toolByName(mkTools(api), "anytype_send_message"), { text: "hello chat" });
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    const call = (api.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe(SPACE);
    expect(call[1]).toBe(CHAT);
    expect(call[2]).toBe("hello chat");
    expect(typeof call[3]).toBe("string");
    expect(res.content[0].text).toContain("Sent");
  });

  it("anytype_send_message passes attachments through (image/file ids)", async () => {
    const api = fakeApi();
    const res = await run(toolByName(mkTools(api), "anytype_send_message"), {
      text: "看这张图",
      attachments: ["file-1", "file-2"],
    });
    const call = (api.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[4]).toEqual(["file-1", "file-2"]);
    expect(res.content[0].text).toContain("2 attachment");
  });

  it("anytype_send_file uploads a local path then sends it as an attachment", async () => {
    const api = fakeApi();
    const res = await run(toolByName(mkTools(api), "anytype_send_file"), {
      path: "/workspace/x/chart.png",
      name: "chart.png",
      text: "这是结果图",
    });
    expect(api.uploadFile).toHaveBeenCalledWith(SPACE, { path: "/workspace/x/chart.png", name: "chart.png" });
    const sent = (api.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sent[0]).toBe(SPACE);
    expect(sent[1]).toBe(CHAT);
    expect(sent[2]).toBe("这是结果图");
    expect(sent[4]).toEqual(["file-1"]);
    expect(res.content[0].text).toContain("file-1");
  });

  it("anytype_send_file accepts a url and requires one of path/url", async () => {
    const api = fakeApi();
    await run(toolByName(mkTools(api), "anytype_send_file"), { url: "https://x/a.pdf" });
    expect(api.uploadFile).toHaveBeenCalledWith(SPACE, { url: "https://x/a.pdf", name: undefined });

    const bad = await run(toolByName(mkTools(api), "anytype_send_file"), {});
    expect(bad.content[0].text).toContain("provide `path` or `url`");
    const both = await run(toolByName(mkTools(api), "anytype_send_file"), { path: "a", url: "b" });
    expect(both.content[0].text).toContain("only one");
  });

  it("anytype_react calls reactToMessage on the current chat", async () => {
    const api = fakeApi();
    const res = await run(toolByName(mkTools(api), "anytype_react"), { message_id: "m1", emoji: "👍" });
    expect(api.reactToMessage).toHaveBeenCalledWith(SPACE, CHAT, "m1", "👍");
    expect(res.content[0].text).toContain("m1");
  });

  it("anytype_edit_message calls editMessage on the current chat", async () => {
    const api = fakeApi();
    const res = await run(toolByName(mkTools(api), "anytype_edit_message"), { message_id: "m2", text: "v2" });
    expect(api.editMessage).toHaveBeenCalledWith(SPACE, CHAT, "m2", "v2");
    expect(res.content[0].text).toContain("m2");
  });

  it("anytype_delete_message calls deleteMessage on the current chat", async () => {
    const api = fakeApi();
    const res = await run(toolByName(mkTools(api), "anytype_delete_message"), { message_id: "m3" });
    expect(api.deleteMessage).toHaveBeenCalledWith(SPACE, CHAT, "m3");
    expect(res.content[0].text).toContain("m3");
  });

  it("chat-op tools surface failures as text instead of throwing", async () => {
    const api = fakeApi({
      reactToMessage: vi.fn(async () => {
        throw new Error("reactToMessage failed: 404");
      }),
    });
    const res = await run(toolByName(mkTools(api), "anytype_react"), { message_id: "x", emoji: "👍" });
    expect(res.content[0].text).toContain("anytype_react failed");
    expect(res.content[0].text).toContain("404");
  });

  // --- templates -----------------------------------------------------------

  it("anytype_templates list renders name/type/id and passes the optional type filter", async () => {
    const api = fakeApi();
    const tools = mkTools(api);
    const res = await run(toolByName(tools, "anytype_templates"), { action: "list", type: "page" });
    expect(api.listTemplates).toHaveBeenCalledWith(SPACE, "page");
    const text = res.content[0].text;
    expect(text).toContain("Weekly Plan");
    expect(text).toContain("(page)");
    expect(text).toContain("[default]");
    expect(text).toContain("tpl-1");
  });

  it("anytype_templates list without a type filter passes undefined", async () => {
    const api = fakeApi();
    await run(toolByName(mkTools(api), "anytype_templates"), { action: "list" });
    expect(api.listTemplates).toHaveBeenCalledWith(SPACE, undefined);
  });

  it("anytype_templates create passes name/typeKey/markdown and returns the id", async () => {
    const api = fakeApi();
    const res = await run(toolByName(mkTools(api), "anytype_templates"), {
      action: "create",
      name: "日记模板",
      type: "page",
      markdown: "# 标题\n- a",
    });
    expect(api.createTemplate).toHaveBeenCalledWith(SPACE, {
      name: "日记模板",
      typeKey: "page",
      markdown: "# 标题\n- a",
    });
    expect(res.content[0].text).toContain("tpl-new");
  });

  it("anytype_templates create requires name and type", async () => {
    const api = fakeApi();
    const noName = await run(toolByName(mkTools(api), "anytype_templates"), { action: "create", type: "page" });
    expect(api.createTemplate).not.toHaveBeenCalled();
    expect(noName.content[0].text).toMatch(/name/);
    const noType = await run(toolByName(mkTools(api), "anytype_templates"), { action: "create", name: "X" });
    expect(api.createTemplate).not.toHaveBeenCalled();
    expect(noType.content[0].text).toMatch(/type/);
  });

  it("anytype_templates delete requires template_id and calls deleteTemplate", async () => {
    const api = fakeApi();
    const missing = await run(toolByName(mkTools(api), "anytype_templates"), { action: "delete" });
    expect(api.deleteTemplate).not.toHaveBeenCalled();
    expect(missing.content[0].text).toMatch(/template_id/);

    const res = await run(toolByName(mkTools(api), "anytype_templates"), { action: "delete", template_id: "tpl-9" });
    expect(api.deleteTemplate).toHaveBeenCalledWith(SPACE, "tpl-9");
    expect(res.content[0].text).toContain("tpl-9");
  });

  it("anytype_create_note passes template_id through as templateId", async () => {
    const api = fakeApi();
    const res = await run(toolByName(mkTools(api), "anytype_create_note"), {
      name: "From tpl",
      template_id: "tpl-1",
    });
    expect(api.createObject).toHaveBeenCalledWith(SPACE, {
      name: "From tpl",
      markdown: undefined,
      templateId: "tpl-1",
    });
    expect(res.content[0].text).toContain("new-123");
    expect(res.content[0].text).toContain("tpl-1");
  });

  // --- precise insertion ---------------------------------------------------

  it("anytype_insert_markdown defaults to position last", async () => {
    const api = fakeApi();
    const res = await run(toolByName(mkTools(api), "anytype_insert_markdown"), {
      id: "obj1",
      markdown: "| A | B |\n| --- | --- |\n| 1 | 2 |",
    });
    expect(api.patchObject).toHaveBeenCalledWith(SPACE, "obj1", [
      { op: "insert_blocks", markdown: "| A | B |\n| --- | --- |\n| 1 | 2 |", position: "last" },
    ]);
    expect(res.content[0].text).toContain("at the end");
  });

  it("anytype_insert_markdown honors position first", async () => {
    const api = fakeApi();
    await run(toolByName(mkTools(api), "anytype_insert_markdown"), {
      id: "obj1",
      markdown: "X",
      position: "first",
    });
    expect(api.patchObject).toHaveBeenCalledWith(SPACE, "obj1", [
      { op: "insert_blocks", markdown: "X", position: "first" },
    ]);
  });

  it("anytype_insert_markdown with before/after omits position", async () => {
    const api = fakeApi();
    await run(toolByName(mkTools(api), "anytype_insert_markdown"), {
      id: "obj1",
      markdown: "X",
      after: "b9",
      position: "last",
    });
    expect(api.patchObject).toHaveBeenCalledWith(SPACE, "obj1", [
      { op: "insert_blocks", markdown: "X", after: "b9" },
    ]);

    const api2 = fakeApi();
    const res = await run(toolByName(mkTools(api2), "anytype_insert_markdown"), {
      id: "obj1",
      markdown: "Y",
      before: "b1",
    });
    expect(api2.patchObject).toHaveBeenCalledWith(SPACE, "obj1", [
      { op: "insert_blocks", markdown: "Y", before: "b1" },
    ]);
    expect(res.content[0].text).toContain("before b1");
  });

  it("anytype_update_object append_markdown honors before/after", async () => {
    const api = fakeApi();
    await run(toolByName(mkTools(api), "anytype_update_object"), {
      id: "obj1",
      append_markdown: "body",
      after: "b2",
    });
    expect(api.patchObject).toHaveBeenCalledWith(SPACE, "obj1", [
      { op: "insert_blocks", markdown: "body", after: "b2" },
    ]);
  });

  // --- web search (not Anytype-specific; uses an injected search fn) ---------

  function mkToolsWithSearch(
    searchFn: unknown,
    opts: { searchApiKey?: string; searchModel?: string } = {},
  ) {
    return createAnytypeTools({
      api: fakeApi(),
      spaceId: SPACE,
      workspaceDir: tmpWorkspace(),
      store: fakeStore(),
      chatId: CHAT,
      defaultWatchCron: DEFAULT_CRON,
      searchApiKey: opts.searchApiKey ?? "test-key",
      searchModel: opts.searchModel,
      searchFn: searchFn as never,
    });
  }

  it("web_search renders the answer text and a 来源 list, passing query/model through", async () => {
    const searchFn = vi.fn(async () => ({
      text: "今天的科技新闻是……",
      sources: [
        { title: "示例来源", url: "https://example.com/a" },
        { title: "Second", url: "https://example.com/b" },
      ],
    }));
    const tools = mkToolsWithSearch(searchFn, { searchModel: "deepseek-flash" });
    const res = await run(toolByName(tools, "web_search"), { query: "今天的科技新闻" });
    const text = res.content[0].text as string;
    expect(text).toContain("今天的科技新闻是……");
    expect(text).toContain("来源：");
    expect(text).toContain("- 示例来源 — https://example.com/a");
    expect(text).toContain("- Second — https://example.com/b");
    expect(searchFn).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "test-key", query: "今天的科技新闻", model: "deepseek-flash" }),
    );
  });

  it("web_search omits the 来源 section when there are no sources", async () => {
    const tools = mkToolsWithSearch(vi.fn(async () => ({ text: "just an answer", sources: [] })));
    const res = await run(toolByName(tools, "web_search"), { query: "q" });
    const text = res.content[0].text as string;
    expect(text).toBe("just an answer");
    expect(text).not.toContain("来源");
  });

  it("web_search forwards max_uses and surfaces an error as text", async () => {
    const searchFn = vi.fn(async () => ({ text: "ok", sources: [] }));
    const tools = mkToolsWithSearch(searchFn);
    await run(toolByName(tools, "web_search"), { query: "q", max_uses: 7 });
    expect(searchFn).toHaveBeenCalledWith(expect.objectContaining({ maxUses: 7 }));

    const bad = mkToolsWithSearch(
      vi.fn(async () => {
        throw new Error("web search failed: 429");
      }),
    );
    const res = await run(toolByName(bad, "web_search"), { query: "q" });
    expect(res.content[0].text).toContain("web_search failed");
    expect(res.content[0].text).toContain("429");
  });

  it("web_search says it is not configured when searchApiKey is empty", async () => {
    const searchFn = vi.fn(async () => ({ text: "x", sources: [] }));
    const tools = mkToolsWithSearch(searchFn, { searchApiKey: "" });
    const res = await run(toolByName(tools, "web_search"), { query: "q" });
    expect(res.content[0].text).toContain("web search is not configured");
    expect(searchFn).not.toHaveBeenCalled();
  });

  // --- web fetch (Lightpanda-backed; uses an injected runFetch) --------------

  function mkToolsWithFetch(
    runFetch: (opts: { url: string; format?: string; strip?: string }) => Promise<{ text: string }>,
  ) {
    return createAnytypeTools({
      api: fakeApi(),
      spaceId: SPACE,
      workspaceDir: tmpWorkspace(),
      store: fakeStore(),
      chatId: CHAT,
      defaultWatchCron: DEFAULT_CRON,
      searchApiKey: "",
      runFetch,
    });
  }

  it("web_fetch defaults to markdown + strip ui and returns the fetched text", async () => {
    const runFetch = vi.fn(async () => ({ text: "# Example Domain\n\nThis domain is for use in examples." }));
    const tools = mkToolsWithFetch(runFetch);
    const res = await run(toolByName(tools, "web_fetch"), { url: "https://example.com" });
    expect(runFetch).toHaveBeenCalledWith({ url: "https://example.com", format: "markdown", strip: "ui" });
    expect(res.content[0].text).toContain("Example Domain");
    expect(res.details).toEqual({});
  });

  it("web_fetch maps format text→semantic_tree_text and semantic→semantic_tree", async () => {
    const runFetch = vi.fn(async () => ({ text: "content" }));
    const tools = mkToolsWithFetch(runFetch);

    await run(toolByName(tools, "web_fetch"), { url: "https://a.test", format: "text" });
    expect(runFetch).toHaveBeenLastCalledWith({ url: "https://a.test", format: "semantic_tree_text", strip: "ui" });

    await run(toolByName(tools, "web_fetch"), { url: "https://b.test", format: "semantic" });
    expect(runFetch).toHaveBeenLastCalledWith({ url: "https://b.test", format: "semantic_tree", strip: "ui" });

    await run(toolByName(tools, "web_fetch"), { url: "https://c.test", format: "html" });
    expect(runFetch).toHaveBeenLastCalledWith({ url: "https://c.test", format: "html", strip: "ui" });
  });

  it("web_fetch says so when the fetch returns empty content", async () => {
    const tools = mkToolsWithFetch(vi.fn(async () => ({ text: "   " })));
    const res = await run(toolByName(tools, "web_fetch"), { url: "https://empty.test" });
    expect(res.content[0].text).toMatch(/no content/i);
  });

  it("web_fetch surfaces a failing runFetch as text instead of throwing", async () => {
    const tools = mkToolsWithFetch(
      vi.fn(async () => {
        throw new Error("lightpanda fetch failed: connection refused");
      }),
    );
    const res = await run(toolByName(tools, "web_fetch"), { url: "https://x.test" });
    expect(res.content[0].text).toContain("web_fetch failed");
    expect(res.content[0].text).toContain("connection refused");
  });
});
