import { describe, it, expect, vi } from "vitest";
import { webSearch, DEFAULT_WEB_SEARCH_URL } from "../src/agent/web-search.js";

/** A Response carrying JSON (jsdom-free: Node 22 has global Response). */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const CANNED = {
  stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 2 },
  content: [
    { type: "thinking", thinking: "let me search" },
    { type: "server_tool_use", name: "web_search", input: { query: "今天的科技新闻" } },
    {
      type: "web_search_tool_result",
      content: [
        { type: "web_search_result", title: "A", url: "https://a.example/1" },
        { type: "web_search_result", title: "A again", url: "https://a.example/1" }, // dup url
        { type: "web_search_result", title: "no url result" }, // missing url -> skip
        { type: "web_search_result", title: "B", url: "https://b.example/2" },
        { type: "web_search_result", url: "https://c.example/3" }, // missing title -> keep ""
      ],
    },
    { type: "text", text: "第一部分" },
    { type: "text", text: "第二部分" },
  ],
};

describe("webSearch", () => {
  it("POSTs the Anthropic-shaped body to DeepSeek and parses text + sources", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(CANNED));
    const res = await webSearch({ apiKey: "sk-test", query: "今天的科技新闻", fetch: fetchMock as unknown as typeof fetch });

    // --- request shape ---
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(DEFAULT_WEB_SEARCH_URL);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["content-type"]).toBe("application/json");

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("deepseek-flash");
    expect(body.max_tokens).toBe(4096);
    expect(body.messages).toEqual([{ role: "user", content: "今天的科技新闻" }]);
    expect(body.tools).toEqual([
      { type: "web_search_20250305", name: "web_search", max_uses: 3 },
    ]);

    // --- response parse ---
    expect(res.text).toBe("第一部分\n\n第二部分");
    expect(res.sources).toEqual([
      { title: "A", url: "https://a.example/1" },
      { title: "B", url: "https://b.example/2" },
      { title: "", url: "https://c.example/3" },
    ]);
  });

  it("honors model / maxUses / maxTokens / baseUrl overrides", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ content: [] }));
    await webSearch({
      apiKey: "sk-test",
      query: "q",
      model: "deepseek-v4-pro",
      maxUses: 5,
      maxTokens: 512,
      baseUrl: "https://example.test/messages",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://example.test/messages");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("deepseek-v4-pro");
    expect(body.max_tokens).toBe(512);
    expect(body.tools[0].max_uses).toBe(5);
  });

  it("throws on a non-2xx response", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "boom" }, 500));
    await expect(
      webSearch({ apiKey: "k", query: "q", fetch: fetchMock as unknown as typeof fetch }),
    ).rejects.toThrow(/web search failed: 500/);
  });

  it("is robust to a malformed / empty response body", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ nonsense: true }));
    const res = await webSearch({ apiKey: "k", query: "q", fetch: fetchMock as unknown as typeof fetch });
    expect(res.text).toBe("");
    expect(res.sources).toEqual([]);
  });

  it("is robust to non-JSON and non-object content items", async () => {
    const notJson = new Response("<html>nope</html>", { status: 200 });
    const res1 = await webSearch({
      apiKey: "k",
      query: "q",
      fetch: vi.fn(async () => notJson) as unknown as typeof fetch,
    });
    expect(res1).toEqual({ text: "", sources: [] });

    const res2 = await webSearch({
      apiKey: "k",
      query: "q",
      fetch: vi.fn(async () =>
        jsonResponse({ content: [null, 42, "x", { type: "text", text: 7 }, { type: "text", text: "ok" }] }),
      ) as unknown as typeof fetch,
    });
    expect(res2.text).toBe("ok");
    expect(res2.sources).toEqual([]);
  });
});
