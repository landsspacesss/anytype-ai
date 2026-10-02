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
    // A discussion's message carries context about the page it belongs to; the
    // agent has no other way to know which page a comment is on.
    const prompt = event.contextNote ? `${event.contextNote}\n\n${stripped}` : stripped;
    try {
      const reply = await this.deps.run(event.spaceId, event.chatId, prompt);
      if (reply.trim().length > 0) await this.deps.send(target, reply);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.deps.send(target, `⚠️ agent error: ${msg}`);
    }
  }
}
