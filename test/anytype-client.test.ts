import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AnytypeClient } from "../src/anytype/client.js";

describe("AnytypeClient.sendMessage", () => {
  it("POSTs to the messages endpoint with auth and idempotency key", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    const c = new AnytypeClient({ baseUrl: "http://x", apiKey: "k", fetch: fetchMock as unknown as typeof fetch });
    await c.sendMessage("s1", "c1", "hello", "key-1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://x/v2/spaces/s1/chats/c1/messages");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer k");
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("key-1");
    expect(JSON.parse(init.body as string)).toEqual({ text: "hello" });
  });

  it("throws on non-2xx", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 403 }));
    const c = new AnytypeClient({ baseUrl: "http://x", apiKey: "k", fetch: fetchMock as unknown as typeof fetch });
    await expect(c.sendMessage("s1", "c1", "hi", "k")).rejects.toThrow(/403/);
  });
});

describe("AnytypeClient.listSpaces", () => {
  it("GETs /v2/spaces and parses body.data", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data: [{ id: "7lotza", name: "" }, { id: "pqdthe", name: "考试" }], total: 2 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    const c = new AnytypeClient({ baseUrl: "http://x", apiKey: "k", fetch: fetchMock as unknown as typeof fetch });
    const spaces = await c.listSpaces();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://x/v2/spaces");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer k");
    expect(spaces).toEqual([{ id: "7lotza", name: "" }, { id: "pqdthe", name: "考试" }]);
  });

  it("returns [] when data is absent and throws on non-2xx", async () => {
    const okMock = vi.fn(async () => new Response("{}", { status: 200 }));
    const c1 = new AnytypeClient({ baseUrl: "http://x", apiKey: "k", fetch: okMock as unknown as typeof fetch });
    expect(await c1.listSpaces()).toEqual([]);

    const errMock = vi.fn(async () => new Response("nope", { status: 500 }));
    const c2 = new AnytypeClient({ baseUrl: "http://x", apiKey: "k", fetch: errMock as unknown as typeof fetch });
    await expect(c2.listSpaces()).rejects.toThrow(/500/);
  });
});

describe("AnytypeClient object edits", () => {
  it("patchObject PATCHes objects/{id} with {ops}", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const c = new AnytypeClient({ baseUrl: "http://x", apiKey: "k", fetch: fetchMock as unknown as typeof fetch });
    const ops = [{ op: "set_properties", set: { name: ["T"] } }];
    await c.patchObject("s1", "obj1", ops);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://x/v2/spaces/s1/objects/obj1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ ops });
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer k");
  });

  it("patchObject throws on non-2xx", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 422 }));
    const c = new AnytypeClient({ baseUrl: "http://x", apiKey: "k", fetch: fetchMock as unknown as typeof fetch });
    await expect(c.patchObject("s1", "obj1", [])).rejects.toThrow(/422/);
  });

  it("deleteObject DELETEs objects/{id}", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "obj1" }), { status: 200 }));
    const c = new AnytypeClient({ baseUrl: "http://x", apiKey: "k", fetch: fetchMock as unknown as typeof fetch });
    await c.deleteObject("s1", "obj1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://x/v2/spaces/s1/objects/obj1");
    expect(init.method).toBe("DELETE");
  });

  it("deleteObject throws on non-2xx", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 403 }));
    const c = new AnytypeClient({ baseUrl: "http://x", apiKey: "k", fetch: fetchMock as unknown as typeof fetch });
    await expect(c.deleteObject("s1", "obj1")).rejects.toThrow(/403/);
  });

  it("listProperties GETs properties and parses body.data", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data: [{ key: "status", name: "Status", format: "select" }], total: 1 }),
          { status: 200 },
        ),
    );
    const c = new AnytypeClient({ baseUrl: "http://x", apiKey: "k", fetch: fetchMock as unknown as typeof fetch });
    const props = await c.listProperties("s1");
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://x/v2/spaces/s1/properties?limit=200");
    expect(props).toEqual([{ key: "status", name: "Status", format: "select" }]);
  });

  it("createProperty POSTs name/format/options and returns the key", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ key: "priority" }), { status: 201 }));
    const c = new AnytypeClient({ baseUrl: "http://x", apiKey: "k", fetch: fetchMock as unknown as typeof fetch });
    const res = await c.createProperty("s1", { name: "Priority", options: [{ name: "High" }] });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://x/v2/spaces/s1/properties");
    expect(init.method).toBe("POST");
    // default format is "select"
    expect(JSON.parse(init.body as string)).toEqual({
      name: "Priority",
      format: "select",
      options: [{ name: "High" }],
    });
    expect(res).toEqual({ key: "priority" });
  });

  it("listTypes GETs types and parses body.data", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ data: [{ key: "page", name: "Page" }] }), { status: 200 }),
    );
    const c = new AnytypeClient({ baseUrl: "http://x", apiKey: "k", fetch: fetchMock as unknown as typeof fetch });
    const types = await c.listTypes("s1");
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://x/v2/spaces/s1/types?limit=200");
    expect(types).toEqual([{ key: "page", name: "Page" }]);
  });

  it("createCollection POSTs and returns the id", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "coll-1" }), { status: 201 }));
    const c = new AnytypeClient({ baseUrl: "http://x", apiKey: "k", fetch: fetchMock as unknown as typeof fetch });
    const res = await c.createCollection("s1", { name: "Reading", items: ["a"] });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://x/v2/spaces/s1/collections");
    expect(JSON.parse(init.body as string)).toEqual({ name: "Reading", items: ["a"] });
    expect(res).toEqual({ id: "coll-1" });
  });

  it("uploadFile by url POSTs JSON with auth and returns the id", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "file-1" }), { status: 201 }));
    const c = new AnytypeClient({ baseUrl: "http://x", apiKey: "k", fetch: fetchMock as unknown as typeof fetch });
    const res = await c.uploadFile("s1", { url: "https://e/a.png", name: "a.png" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://x/v2/spaces/s1/files");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ url: "https://e/a.png", name: "a.png" });
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(res).toEqual({ id: "file-1" });
  });

  it("uploadFile by path sends multipart with only Authorization (no Content-Type)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anytype-upload-"));
    const file = path.join(dir, "note.txt");
    fs.writeFileSync(file, "hello");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "file-2" }), { status: 201 }));
    const c = new AnytypeClient({ baseUrl: "http://x", apiKey: "k", fetch: fetchMock as unknown as typeof fetch });
    const res = await c.uploadFile("s1", { path: file });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://x/v2/spaces/s1/files");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer k");
    expect(headers["Content-Type"]).toBeUndefined();
    expect(res).toEqual({ id: "file-2" });
  });

  it("uploadFile with neither url nor path throws", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    const c = new AnytypeClient({ baseUrl: "http://x", apiKey: "k", fetch: fetchMock as unknown as typeof fetch });
    await expect(c.uploadFile("s1", {})).rejects.toThrow(/url or path/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
