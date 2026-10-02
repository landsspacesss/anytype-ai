import fs from "node:fs";
import path from "node:path";

/** The console's persisted identity: the one-to-one space that carries global powers. */
export interface ConsoleRecord {
  spaceId: string;
  /** The space's chat id (informational; discovery re-resolves it anyway). */
  chatId?: string;
  /** ISO timestamp of when the console was bootstrapped. */
  bootstrappedAt: string;
}

/** Read the console record, or null when absent/unreadable/malformed. */
export function readConsole(file: string): ConsoleRecord | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
    if (typeof raw.spaceId !== "string" || raw.spaceId.length === 0) return null;
    const rec: ConsoleRecord = {
      spaceId: raw.spaceId,
      bootstrappedAt: typeof raw.bootstrappedAt === "string" ? raw.bootstrappedAt : "",
    };
    if (typeof raw.chatId === "string") rec.chatId = raw.chatId;
    return rec;
  } catch {
    return null;
  }
}

/** Write the console record (pretty JSON; creates parent dirs). */
export function writeConsole(file: string, rec: ConsoleRecord): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(rec, null, 2), "utf-8");
}
