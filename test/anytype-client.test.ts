import { describe, it, expect, vi } from "vitest";
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
