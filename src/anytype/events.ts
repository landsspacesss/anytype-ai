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
  const attachments = parseAttachments(r.attachments);
  const event: NormalizedEvent = {
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
  if (attachments.length > 0) event.attachments = attachments;
  return event;
}

/** Message attachments (`[{id, type}]`), skipping malformed entries. */
function parseAttachments(raw: unknown): Array<{ id: string; type: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ id: string; type: string }> = [];
  for (const a of raw) {
    if (a === null || typeof a !== "object") continue;
    const rec = a as Record<string, unknown>;
    if (typeof rec.id === "string" && rec.id.length > 0) {
      out.push({ id: rec.id, type: typeof rec.type === "string" ? rec.type : "file" });
    }
  }
  return out;
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
