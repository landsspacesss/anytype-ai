import type { NormalizedEvent } from "../types.js";
import { normalizeMessage, parseSseChunk, type NormalizeCtx } from "./events.js";

/**
 * Handle one parsed SSE frame. Anytype wraps chat messages as
 * `{"id":"<stateId>","type":"message_added","message":{...ChatMessage...}}`
 * (phase0 finding), so we dispatch on the wrapper's `type` and feed
 * `ev.message` — never the wrapper — into `normalizeMessage`. All other event
 * types (e.g. `state_updated`) and malformed frames are ignored.
 */
export function handleEvent(
  ev: unknown,
  ctx: NormalizeCtx,
  onEvent: (e: NormalizedEvent) => void,
  since?: string,
): void {
  if (!ev || typeof ev !== "object") return;
  const wrapper = ev as { type?: unknown; message?: unknown };
  if (wrapper.type !== "message_added") return;
  // Backlog suppression: the stream replays the last `limit` messages as
  // `message_added` on connect. Skip any message whose ISO-8601 `at` predates
  // `since` (subscription start). ISO-8601 UTC strings compare lexicographically.
  // Fail-open: messages with no/absent `at` are never skipped.
  if (since) {
    const raw = wrapper.message as { at?: unknown } | null | undefined;
    const at = raw && typeof raw === "object" ? raw.at : undefined;
    if (typeof at === "string" && at < since) return;
  }
  const normalized = normalizeMessage(wrapper.message, ctx);
  if (normalized) onEvent(normalized);
}

export interface StreamDeps {
  baseUrl: string;
  apiKey: string;
  spaceId: string;
  chatId: string;
  isDirect: boolean;
  botParticipantId: string;
  objectId?: string;
  /**
   * ISO-8601 timestamp of subscription start. Messages replayed by the stream
   * with an older `at` (the backlog) are dropped; missing `at` fails open.
   */
  since?: string;
  onEvent: (e: NormalizedEvent) => void;
  /** Injectable for tests; defaults to the global fetch. */
  fetchFn?: typeof fetch;
}

/**
 * Open the per-chat SSE stream `.../chats/{chatId}/messages/stream` and dispatch
 * normalized messages until `signal` is aborted. Reconnects on transport errors
 * (unless aborted). `parseSseChunk` ignores the `id:`/`event:`/`: keepalive`
 * lines and yields the `data:` JSON objects.
 */
export function subscribeChat(deps: StreamDeps, signal: AbortSignal): Promise<void> {
  const url = `${deps.baseUrl}/v2/spaces/${deps.spaceId}/chats/${deps.chatId}/messages/stream?heartbeat=30`;
  const fetchFn = deps.fetchFn ?? fetch;
  const ctx: NormalizeCtx = {
    spaceId: deps.spaceId,
    chatId: deps.chatId,
    botParticipantId: deps.botParticipantId,
    isDirect: deps.isDirect,
    objectId: deps.objectId,
  };
  return (async () => {
    while (!signal.aborted) {
      try {
        const res = await fetchFn(url, {
          headers: { Authorization: `Bearer ${deps.apiKey}`, Accept: "text/event-stream" },
          signal,
        });
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const { events, rest } = parseSseChunk(buffer);
          buffer = rest;
          for (const raw of events) handleEvent(raw, ctx, deps.onEvent, deps.since);
        }
      } catch {
        if (signal.aborted) return;
      }
      if (signal.aborted) return;
      await new Promise((r) => setTimeout(r, 2000));
    }
  })();
}
