import type { Member } from "../types.js";

/**
 * Resolve the bot's participant id within a space by matching its account
 * identity. A member's `id` is `_participant_<fullSpaceId>_<identity>`, so the
 * bot's participant id differs per space and must be resolved from the space's
 * member list (phase0 finding — a single BOT_PARTICIPANT_ID constant is wrong
 * for multi-space).
 */
export function resolveBotParticipantId(
  members: Member[],
  botIdentity: string | undefined,
): string | undefined {
  if (!botIdentity) return undefined;
  return members.find((m) => m.identity === botIdentity)?.id;
}
