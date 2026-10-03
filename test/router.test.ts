import { describe, it, expect, vi } from "vitest";
import { Router } from "../src/router/router.js";
import type { NormalizedEvent } from "../src/types.js";
import type { AgentProgress } from "../src/session/manager.js";

/** Minimal fake status transport; each method is a spy. */
function fakeStatus() {
  return {
    post: vi.fn(async () => "status-id-1"),
    edit: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  };
}

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

  it("prefixes the sender name in a multi-person space", async () => {
    const run = vi.fn(async () => "ok");
    const send = vi.fn(async () => {});
    const r = new Router({ botName: "ai", run, send });
    await r.handle(ev({ mentionsBot: true, text: "@ai 帮忙", senderName: "landspace" }));
    expect(run).toHaveBeenCalledWith("s", "c", "[landspace] 帮忙");
  });

  it("does not prefix a sender name when absent (private chat)", async () => {
    const run = vi.fn(async () => "ok");
    const send = vi.fn(async () => {});
    const r = new Router({ botName: "ai", run, send });
    await r.handle(ev({ mentionsBot: true, text: "@ai 帮忙" }));
    expect(run).toHaveBeenCalledWith("s", "c", "帮忙");
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

describe("Router status message", () => {
  it("posts nothing when the turn finishes before the delay", async () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn(async () => "fast reply");
      const send = vi.fn(async () => {});
      const status = fakeStatus();
      const r = new Router({ botName: "ai", run, send, status, statusDelayMs: 1500 });

      await r.handle(ev({ isDirect: true, text: "hi" }));

      expect(status.post).not.toHaveBeenCalled();
      expect(status.edit).not.toHaveBeenCalled();
      expect(status.remove).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledWith(expect.anything(), "fast reply");
    } finally {
      vi.useRealTimers();
    }
  });

  it("posts once, coalesces edits, and removes the placeholder on a slow turn", async () => {
    vi.useFakeTimers();
    try {
      let resolveRun!: (v: string) => void;
      const run = vi.fn(
        (_s: string, _c: string, _p: string, onProgress?: (p: AgentProgress) => void) => {
          // Two tool calls in quick succession → one coalesced edit (the last).
          onProgress?.({ kind: "tool", tool: "anytype_search", args: { query: "物理" } });
          onProgress?.({ kind: "tool", tool: "anytype_list_objects", args: {} });
          return new Promise<string>((res) => {
            resolveRun = res;
          });
        },
      );
      const send = vi.fn(async () => {});
      const status = fakeStatus();
      const r = new Router({ botName: "ai", run, send, status, statusDelayMs: 1500 });

      const done = r.handle(ev({ isDirect: true, text: "hi" }));

      // Nothing posted before the delay elapses.
      expect(status.post).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1500);
      expect(status.post).toHaveBeenCalledTimes(1);
      expect(status.post).toHaveBeenCalledWith(expect.anything(), "🧠 思考中…");

      // The trailing edit window opens; the coalesced edit carries the LATEST.
      await vi.advanceTimersByTimeAsync(800);
      expect(status.edit).toHaveBeenCalledTimes(1);
      expect(status.edit).toHaveBeenCalledWith(
        expect.anything(),
        "status-id-1",
        "⏳ 正在 anytype_list_objects…",
      );

      resolveRun("the answer");
      await done;

      expect(status.remove).toHaveBeenCalledTimes(1);
      expect(status.remove).toHaveBeenCalledWith(expect.anything(), "status-id-1");
      // The reply is still sent, after the placeholder is retracted.
      expect(send).toHaveBeenCalledWith(expect.anything(), "the answer");
    } finally {
      vi.useRealTimers();
    }
  });

  it("without a status transport, a multi-line reply is sent one message per line", async () => {
    const run = vi.fn(async () => "第一行\n\n第二行");
    const send = vi.fn(async () => {});
    const r = new Router({ botName: "ai", run, send });
    await r.handle(ev({ isDirect: true, text: "hi" }));
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(1, expect.anything(), "第一行");
    expect(send).toHaveBeenNthCalledWith(2, expect.anything(), "第二行");
  });

  it("still removes the placeholder and sends the error reply when the turn throws", async () => {
    vi.useFakeTimers();
    try {
      let rejectRun!: (e: Error) => void;
      const run = vi.fn(
        () =>
          new Promise<string>((_res, rej) => {
            rejectRun = rej;
          }),
      );
      const send = vi.fn(async () => {});
      const status = fakeStatus();
      const r = new Router({ botName: "ai", run, send, status, statusDelayMs: 1500 });

      const done = r.handle(ev({ isDirect: true, text: "hi" }));

      await vi.advanceTimersByTimeAsync(1500);
      expect(status.post).toHaveBeenCalledTimes(1);

      rejectRun(new Error("boom"));
      await done;

      expect(status.remove).toHaveBeenCalledTimes(1);
      expect(status.remove).toHaveBeenCalledWith(expect.anything(), "status-id-1");
      expect(send).toHaveBeenCalledTimes(1);
      expect(String((send.mock.calls[0] as unknown[])[1])).toMatch(/error/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the turn working when posting the status fails", async () => {
    vi.useFakeTimers();
    try {
      let resolveRun!: (v: string) => void;
      const run = vi.fn(
        () =>
          new Promise<string>((res) => {
            resolveRun = res;
          }),
      );
      const send = vi.fn(async () => {});
      const status = fakeStatus();
      status.post.mockRejectedValueOnce(new Error("403 forbidden"));
      const r = new Router({ botName: "ai", run, send, status, statusDelayMs: 1500, });

      const done = r.handle(ev({ isDirect: true, text: "hi" }));
      await vi.advanceTimersByTimeAsync(1500);
      expect(status.post).toHaveBeenCalledTimes(1);

      resolveRun("ok anyway");
      await done;

      expect(status.remove).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledWith(expect.anything(), "ok anyway");
    } finally {
      vi.useRealTimers();
    }
  });
});
