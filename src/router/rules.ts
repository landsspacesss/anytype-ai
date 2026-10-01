import type { NormalizedEvent } from "../types.js";

export function shouldTrigger(event: NormalizedEvent): boolean {
  if (event.isBotSelf) return false;
  return event.mentionsBot || event.isDirect;
}

export function stripBotMention(text: string, botName: string): string {
  const escaped = botName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`@${escaped}\\b`, "gi");
  return text.replace(re, " ").replace(/\s+/g, " ").trim();
}
