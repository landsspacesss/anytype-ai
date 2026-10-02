import { describe, it, expect, vi } from "vitest";
import { webFetch, buildFetchArgs } from "../src/agent/web-fetch.js";
import type { WebFetchExec } from "../src/agent/web-fetch.js";

/** An exec stub that returns canned stdout (records the call). */
function fakeExec(stdout: string, stderr = ""): ReturnType<typeof vi.fn> & WebFetchExec {
  return vi.fn(async () => ({ stdout, stderr })) as unknown as ReturnType<typeof vi.fn> & WebFetchExec;
}

describe("buildFetchArgs", () => {
  it("defaults to markdown + strip ui", () => {
    expect(buildFetchArgs({ url: "https://example.com" })).toEqual([
      "fetch",
      "--dump",
      "markdown",
      "--strip-mode",
      "ui",
      "https://example.com",
    ]);
  });

  it("honors format and strip overrides", () => {
    expect(buildFetchArgs({ url: "https://x.test", format: "semantic_tree", strip: "js,ui" })).toEqual([
      "fetch",
      "--dump",
      "semantic_tree",
      "--strip-mode",
      "js,ui",
      "https://x.test",
    ]);
  });
});

describe("webFetch", () => {
  it("runs lightpanda fetch with the built args, timeout and a large maxBuffer", async () => {
    const exec = fakeExec("  # Example Domain\nhello  \n");
    const res = await webFetch({ url: "https://example.com", _exec: exec });
    expect(res).toEqual({ text: "# Example Domain\nhello", truncated: false });
    expect(exec).toHaveBeenCalledTimes(1);
    const [file, args, options] = exec.mock.calls[0] as unknown as [
      string,
      string[],
      { timeout?: number; maxBuffer?: number },
    ];
    expect(file).toBe("lightpanda");
    expect(args).toEqual(["fetch", "--dump", "markdown", "--strip-mode", "ui", "https://example.com"]);
    expect(options.timeout).toBe(30000);
    expect(options.maxBuffer).toBe(32 * 1024 * 1024);
  });

  it("passes custom bin, format, strip and timeout through", async () => {
    const exec = fakeExec("ok");
    await webFetch({
      url: "https://x.test",
      bin: "/opt/lp",
      format: "html",
      strip: "js",
      timeoutMs: 1234,
      _exec: exec,
    });
    const [file, args, options] = exec.mock.calls[0] as unknown as [
      string,
      string[],
      { timeout?: number },
    ];
    expect(file).toBe("/opt/lp");
    expect(args).toEqual(["fetch", "--dump", "html", "--strip-mode", "js", "https://x.test"]);
    expect(options.timeout).toBe(1234);
  });

  it("truncates to maxChars and flags it", async () => {
    const exec = fakeExec("x".repeat(100));
    const res = await webFetch({ url: "https://x.test", maxChars: 10, _exec: exec });
    expect(res.text).toBe("x".repeat(10));
    expect(res.truncated).toBe(true);
  });

  it("does not flag truncation when output fits exactly", async () => {
    const res = await webFetch({ url: "https://x.test", maxChars: 3, _exec: fakeExec("abc") });
    expect(res).toEqual({ text: "abc", truncated: false });
  });

  it("throws with the stderr tail on a non-zero exit", async () => {
    const exec = vi.fn(async () => {
      const err = new Error("Command failed") as Error & { stderr?: string };
      err.stderr = "error: failed to load page\nconnection refused";
      throw err;
    }) as unknown as WebFetchExec;
    await expect(webFetch({ url: "https://x.test", _exec: exec })).rejects.toThrow(
      /lightpanda fetch failed: [\s\S]*connection refused/,
    );
  });

  it("falls back to the error message when there is no stderr", async () => {
    const exec = vi.fn(async () => {
      throw new Error("spawn lightpanda ENOENT");
    }) as unknown as WebFetchExec;
    await expect(webFetch({ url: "https://x.test", _exec: exec })).rejects.toThrow(
      /lightpanda fetch failed: spawn lightpanda ENOENT/,
    );
  });
});
