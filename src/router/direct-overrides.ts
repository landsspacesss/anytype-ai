import fs from "node:fs";
import path from "node:path";

/**
 * Per-space override of the "direct" (private-chat) determination that controls
 * whether the bot answers WITHOUT an @-mention.
 *
 * Normally `isDirect` is derived from a space's member count (≤2 members =
 * private → answer everything). A console operator can force a whole space to
 * `direct` (answer every message) or `group` (require an @), regardless of
 * membership. Persisted so it survives restarts. A space absent from the map
 * falls back to the automatic member-count rule.
 */
export class DirectOverrides {
  private map = new Map<string, boolean>();
  private loaded = false;

  constructor(private readonly filePath: string) {}

  /** Read the JSON file into memory. Tolerates a missing/corrupt file (starts empty). */
  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as { spaces?: Record<string, unknown> };
      const spaces = parsed?.spaces;
      if (spaces && typeof spaces === "object") {
        for (const [id, v] of Object.entries(spaces)) {
          if (typeof v === "boolean") this.map.set(id, v);
        }
      }
    } catch {
      this.map.clear();
    }
  }

  /** The forced value for a space, or undefined when it uses the automatic rule. */
  get(spaceId: string): boolean | undefined {
    return this.map.get(spaceId);
  }

  set(spaceId: string, direct: boolean): void {
    this.map.set(spaceId, direct);
    this.save();
  }

  /** Remove a space's override (back to the automatic member-count rule). */
  clear(spaceId: string): void {
    if (this.map.delete(spaceId)) this.save();
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(
      this.filePath,
      JSON.stringify({ spaces: Object.fromEntries(this.map) }, null, 2),
      "utf-8",
    );
  }
}
