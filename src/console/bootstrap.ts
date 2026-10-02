import crypto from "node:crypto";
import type { HeartGrpc } from "../anytype/grpc.js";
import { parseAnytypeLink } from "./links.js";
import { writeConsole } from "./console-store.js";

/** The bot's own shareable 1:1 link (user opens it → one-to-one with the bot). */
export function botOneToOneLink(identity: string, key: string): string {
  return `anytype://hi/?id=${identity}&key=${key}`;
}

/** A fresh random request key (base64url, ~32 bytes). */
export function newRequestKey(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * Act on a link the user shared:
 *  - `onetoone` → mirror the space (WorkspaceCreate) and RECORD it as the console.
 *  - `invite`   → join the shared space (SpaceJoin); nothing recorded.
 * Never throws; returns a discriminated result.
 */
export async function bootstrapFromLink(
  g: HeartGrpc,
  link: string,
  consoleFile: string,
): Promise<{ ok: true; spaceId: string; kind: "invite" | "onetoone" } | { ok: false; error: string }> {
  const parsed = parseAnytypeLink(link);
  if (!parsed) return { ok: false, error: "无法识别的链接（既不是邀请链接也不是 1:1 链接）" };
  try {
    if (parsed.kind === "onetoone") {
      const spaceId = await g.workspaceCreateOneToOne(parsed.identity, parsed.key);
      writeConsole(consoleFile, { spaceId, bootstrappedAt: new Date().toISOString() });
      return { ok: true, spaceId, kind: "onetoone" };
    }
    await g.spaceJoin({ cid: parsed.cid, key: parsed.key });
    return { ok: true, spaceId: "", kind: "invite" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
