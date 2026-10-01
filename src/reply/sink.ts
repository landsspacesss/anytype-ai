import type { ChatTarget } from "../types.js";
import { chunkMessage } from "./chunk.js";

export interface ReplySinkOptions {
  send: (target: ChatTarget, text: string, idempotencyKey: string) => Promise<void>;
  maxLen: number;
  keyFor: (target: ChatTarget) => string;
}

export class ReplySink {
  constructor(private opts: ReplySinkOptions) {}

  async send(target: ChatTarget, text: string): Promise<void> {
    const chunks = chunkMessage(text, this.opts.maxLen);
    if (chunks.length === 0) return;
    const base = this.opts.keyFor(target);
    for (let i = 0; i < chunks.length; i++) {
      await this.opts.send(target, chunks[i], `${base}-${i}`);
    }
  }
}
