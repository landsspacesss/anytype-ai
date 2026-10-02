import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createAnytypeTools } from "../src/agent/anytype-tools.js";
import type { AnytypeClient } from "../src/anytype/client.js";
import type { WatchStore, WatchRecord } from "../src/watch/store.js";

/** A throwaway workspace dir for tool tests. */
function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "anytype-tools-"));
}

type ExecResult = { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details: unknown };

function fakeApi(overrides: Partial<Record<keyof AnytypeClient, unknown>> = {}): AnytypeClient {
  const base = {
    listObjects: vi.fn(async () => [
      { id: "obj1", name: "日常试卷1", type: "page" },
      { id: "obj2", name: "考试大纲", type: "page" },
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
    createCollection: vi.fn(async () => ({ id: "coll-1" })),
    uploadFile: vi.fn(async () => ({ id: "file-1" })),
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

const SPACE = "pqdthe";
const CHAT = "chat-42";

function mkTools(api: AnytypeClient, store: WatchStore = fakeStore(), chatId: string = CHAT) {
  return createAnytypeTools({ api, spaceId: SPACE, workspaceDir: tmpWorkspace(), store, chatId });
}

describe("createAnytypeTools", () => {
  it("returns the nineteen Anytype tools with expected names", () => {
    const tools = mkTools(fakeApi());
    expect(tools).toHaveLength(19);
    expect(tools.map((t) => t.name)).toEqual([
      "anytype_list_objects",
      "anytype_search",
      "anytype_read_object",
      "anytype_download_images",
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
      "anytype_create_collection",
      "anytype_collection_items",
      "anytype_upload_file",
      "anytype_watch",
    ]);
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
    expect(text).toContain("考试大纲");
    expect(text).toContain("(page)");
    expect(text).toContain("obj1");
    expect(res.details).toEqual({});
  });

  it("anytype_list_objects honors an optional limit", async () => {
    const api = fakeApi();
    const tools = mkTools(api);
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
    expect(text).toContain("appended");
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
    });
    expect(store.save).toHaveBeenCalled();
    expect(res.content[0].text).toContain("已订阅");
    expect(res.content[0].text).toContain("日常试卷1");
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

  it("anytype_watch list renders label + id + chat", async () => {
    const store = fakeStore();
    store.forSpace = vi.fn(() => [
      { objectId: "obj1", spaceId: SPACE, chatId: CHAT, label: "日常试卷1", snapshot: [] },
    ]);
    const res = await run(toolByName(mkTools(fakeApi(), store), "anytype_watch"), { action: "list" });
    expect(store.forSpace).toHaveBeenCalledWith(SPACE);
    const text = res.content[0].text;
    expect(text).toContain("日常试卷1");
    expect(text).toContain("obj1");
    expect(text).toContain(CHAT);
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
});
