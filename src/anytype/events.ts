import type { NormalizedEvent } from "../types.js";

export interface NormalizeCtx {
  botParticipantId: string;
  isDirect: boolean;
  objectId?: string;
}

export function normalizeMessage(raw: unknown, ctx: NormalizeCtx): NormalizedEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = r.id, chatId = r.chat_id, spaceId = r.space_id, creator = r.creator, text = r.text;
  if (typeof id !== "string" || typeof chatId !== "string" || typeof spaceId !== "string") return null;
  if (typeof creator !== "string") return null;
  const mentionList = Array.isArray(r.mentions) ? r.mentions : [];
  const mentions = mentionList as Array<{ participant_id?: string }>;
  const mentionsBot = mentions.some((m) => m?.participant_id === ctx.botParticipantId);
  return {
    spaceId,
    chatId,
    messageId: id,
    senderId: creator,
    text: typeof text === "string" ? text : "",
    mentionsBot,
    isBotSelf: creator === ctx.botParticipantId,
    isDirect: ctx.isDirect,
    objectId: ctx.objectId,
  };
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
