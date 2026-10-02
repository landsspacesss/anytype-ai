/**
 * A page/object's Discussion is itself a chat — the v2 API returns its id as a
 * `chat_id`, so `listChats` does NOT include it. Extract the discussion id from
 * an object document, tolerating shape variations: top-level `discussion` or
 * `properties.discussion_id` (array or string). Returns undefined when the
 * object has no discussion (chats, types, templates, and system objects don't).
 */
export function extractDiscussionId(doc: unknown): string | undefined {
  if (doc === null || typeof doc !== "object") return undefined;
  const d = doc as Record<string, unknown>;
  if (typeof d.discussion === "string" && d.discussion.length > 0) return d.discussion;
  const props = d.properties;
  if (props !== null && typeof props === "object") {
    const did = (props as Record<string, unknown>).discussion_id;
    if (Array.isArray(did) && typeof did[0] === "string" && did[0].length > 0) return did[0];
    if (typeof did === "string" && did.length > 0) return did;
  }
  return undefined;
}
