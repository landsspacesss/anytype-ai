/** A parsed slash command: the command word (no leading `/`, lowercased) + args. */
export interface ParsedCommand {
  command: string;
  args: string;
}

/**
 * Parse a chat message as a slash command.
 *
 * Returns null when the (trimmed) text does not start with `/`. Otherwise the
 * command is the first whitespace-delimited token after the slash, lowercased;
 * `args` is the trimmed remainder. A bare `/` yields `{ command: "", args: "" }`.
 */
export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const rest = trimmed.slice(1);
  const m = rest.match(/^(\S*)\s*([\s\S]*)$/);
  const command = (m?.[1] ?? "").toLowerCase();
  const args = (m?.[2] ?? "").trim();
  return { command, args };
}
