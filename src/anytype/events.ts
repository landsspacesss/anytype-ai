import type { NormalizedEvent } from "../types.js";

export interface NormalizeCtx {
  spaceId: string;
  chatId: string;
  botParticipantId: string;
  isDirect: boolean;
  objectId?: string;
}

export function normalizeMessage(raw: unknown, ctx: NormalizeCtx): NormalizedEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.author_id !== "string") return null;
  const text = typeof r.text === "string" ? r.text : "";
  return {
    spaceId: ctx.spaceId,
    chatId: ctx.chatId,
    messageId: r.id,
    senderId: r.author_id,
    text,
    mentionsBot: hasMentionOf(text, ctx.botParticipantId),
    isBotSelf: r.author_id === ctx.botParticipantId,
    isDirect: ctx.isDirect,
    objectId: ctx.objectId,
  };
}

export function hasMentionOf(text: string, participantId: string): boolean {
  const re = /<mention\b[^>]*\bobject_id="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1] === participantId) return true;
  }
  return false;
}

export function parseSseChunk(buffer: string): { events: unknown[]; rest: string } {
  const events: unknown[] = [];
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  for (const part of parts) {
    for (const line of part.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      try { events.push(JSON.parse(payload)); } catch { /* skip */ }
    }
  }
  return { events, rest };
}
