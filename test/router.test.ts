import { describe, it, expect, vi } from "vitest";
import { Router } from "../src/router/router.js";
import type { NormalizedEvent } from "../src/types.js";

function ev(p: Partial<NormalizedEvent>): NormalizedEvent {
  return { spaceId: "s", chatId: "c", messageId: "m", senderId: "u", text: "hi",
    mentionsBot: false, isBotSelf: false, isDirect: false, ...p };
}

describe("Router", () => {
  it("ignores non-triggering events", async () => {
    const run = vi.fn(async () => "x");
    const send = vi.fn(async () => {});
    const r = new Router({ botName: "ai", run, send });
    await r.handle(ev({}));
    expect(run).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("runs the agent and sends the reply on a mention", async () => {
    const run = vi.fn(async () => "the answer");
    const send = vi.fn(async () => {});
    const r = new Router({ botName: "ai", run, send });
    await r.handle(ev({ mentionsBot: true, text: "@ai what" }));
    expect(run).toHaveBeenCalledWith("s", "c", "what");
    expect(send).toHaveBeenCalledWith({ spaceId: "s", chatId: "c", objectId: undefined }, "the answer");
  });

  it("prepends contextNote to the prompt when present", async () => {
    const run = vi.fn(async () => "ok");
    const send = vi.fn(async () => {});
    const r = new Router({ botName: "ai", run, send });
    await r.handle(ev({ mentionsBot: true, text: "@ai 讲了什么", contextNote: "（你正在页面「X」的讨论区）" }));
    expect(run).toHaveBeenCalledWith("s", "c", "（你正在页面「X」的讨论区）\n\n讲了什么");
  });

  it("tells the agent about message attachments", async () => {
    const run = vi.fn(async () => "ok");
    const send = vi.fn(async () => {});
    const r = new Router({ botName: "ai", run, send });
    await r.handle(
      ev({
        mentionsBot: true,
        text: "@ai 看下",
        attachments: [
          { id: "file-1", type: "file" },
          { id: "img-2", type: "image" },
        ],
      }),
    );
    const prompt = run.mock.calls[0][2] as string;
    expect(prompt).toContain("附带了 2 个文件");
    expect(prompt).toContain("id=file-1");
    expect(prompt).toContain("id=img-2");
    expect(prompt).toContain("anytype_read_object"); // how to read images
    expect(prompt).toContain("anytype_download_file"); // how to read files
    expect(prompt).toContain("看下"); // the user's text is still there
  });

  it("sends an error message when the agent fails", async () => {
    const run = vi.fn(async () => { throw new Error("boom"); });
    const send = vi.fn(async () => {});
    const r = new Router({ botName: "ai", run, send });
    await r.handle(ev({ isDirect: true, text: "hi" }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(String((send.mock.calls[0] as unknown[])[1])).toMatch(/error/i);
  });
});
