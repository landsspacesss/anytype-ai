import type { ChatTarget, NormalizedEvent } from "../types.js";
import type { AgentProgress } from "../session/manager.js";
import { shouldTrigger, stripBotMention } from "./rules.js";
import { StatusReporter, sendLines, type StatusTransport } from "../reply/status.js";

export interface RouterDeps {
  botName: string;
  run: (
    spaceId: string,
    chatId: string,
    prompt: string,
    onProgress?: (p: AgentProgress) => void,
  ) => Promise<string>;
  send: (target: ChatTarget, text: string) => Promise<void>;
  /**
   * Optional live tool-call status transport. When absent (tests, command
   * paths) no status message is posted.
   */
  status?: StatusTransport;
  /** Delay (ms) before the status placeholder is posted. Default 1500. */
  statusDelayMs?: number;
}

export class Router {
  constructor(private deps: RouterDeps) {}

  async handle(event: NormalizedEvent): Promise<void> {
    if (!shouldTrigger(event)) return;
    const target: ChatTarget = { spaceId: event.spaceId, chatId: event.chatId, objectId: event.objectId };
    const stripped = stripBotMention(event.text, this.deps.botName) || event.text;
    // Prepend any context: attachments first (the agent must know the files
    // exist and how to read them), then discussion context.
    const parts: string[] = [];
    if (event.attachments && event.attachments.length > 0) {
      const lines = event.attachments.map((a) => `- ${a.type} id=${a.id}`);
      parts.push(
        `（本条消息附带了 ${event.attachments.length} 个文件，用户想让你看：\n${lines.join("\n")}\n` +
          `读取方式：图片用 anytype_read_object（能直接看到图）；其他文件用 anytype_download_file 下载，再用 shell 工具（pdftotext/unzip/cat 等）读取内容。）`,
      );
    }
    if (event.contextNote) parts.push(event.contextNote);
    parts.push(stripped);
    const prompt = parts.join("\n\n");

    // Live status: a self-updating placeholder that shows the current tool call
    // and is retracted when the turn ends (before the real reply is sent).
    const reporter = this.deps.status
      ? new StatusReporter({
          status: this.deps.status,
          send: (t, x) => this.deps.send(t, x),
          delayMs: this.deps.statusDelayMs,
        })
      : undefined;

    let reply: string | undefined;
    let errorMsg: string | undefined;
    reporter?.start(target);
    try {
      const args: Parameters<RouterDeps["run"]> = [event.spaceId, event.chatId, prompt];
      // Only pass the 4th (progress) arg when a status reporter is active, so
      // callers without status see the original 3-arg call.
      if (reporter) args.push((p) => reporter.onProgress(p));
      reply = await this.deps.run(...args);
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
    } finally {
      // Retract the transient bubbles before sending anything else.
      await reporter?.stop();
    }

    if (errorMsg !== undefined) {
      await this.deps.send(target, `⚠️ agent error: ${errorMsg}`);
    } else if (reply !== undefined && reply.trim().length > 0) {
      // With a reporter, hand it the answer: it drops every transient bubble
      // then sends one message per line. Without one, split the lines here.
      if (reporter) await reporter.finish(reply);
      else await sendLines(this.deps.send, target, reply);
    }
  }
}
