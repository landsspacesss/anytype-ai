import type { ChatTarget, NormalizedEvent } from "../types.js";
import { shouldTrigger, stripBotMention } from "./rules.js";

export interface RouterDeps {
  botName: string;
  run: (spaceId: string, chatId: string, prompt: string) => Promise<string>;
  send: (target: ChatTarget, text: string) => Promise<void>;
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
    try {
      const reply = await this.deps.run(event.spaceId, event.chatId, prompt);
      if (reply.trim().length > 0) await this.deps.send(target, reply);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.deps.send(target, `⚠️ agent error: ${msg}`);
    }
  }
}
