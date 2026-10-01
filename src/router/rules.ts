import type { NormalizedEvent } from "../types.js";

export function shouldTrigger(event: NormalizedEvent): boolean {
  if (event.isBotSelf) return false;
  return event.mentionsBot || event.isDirect;
}

export function stripBotMention(text: string, botName: string): string {
  const escaped = botName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Real Anytype mention tag: <mention object_id="...">DISPLAY_NAME</mention>
  const tagRe = new RegExp(`<mention\\b[^>]*>\\s*@?${escaped}\\s*</mention>`, "gi");
  let out = text.replace(tagRe, " ");
  // Legacy/plain @name
  out = out.replace(new RegExp(`@${escaped}\\b`, "gi"), " ");
  return out.replace(/\s+/g, " ").trim();
}
