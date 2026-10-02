import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bootstrapFromLink, botOneToOneLink } from "../src/console/bootstrap.js";
import { readConsole } from "../src/console/console-store.js";

function tmpConsole(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "console-")), "console.json");
}

describe("botOneToOneLink", () => {
  it("builds the deeplink form", () => {
    expect(botOneToOneLink("BOTID", "KEY1")).toBe("anytype://hi/?id=BOTID&key=KEY1");
  });
});

describe("bootstrapFromLink", () => {
  it("mirrors a 1:1 link and records the console", async () => {
    const g = { workspaceCreateOneToOne: vi.fn(async () => "spNEW") } as any;
    const f = tmpConsole();
    const r = await bootstrapFromLink(g, "https://hi.any.coop/USERID#KEYX", f);
    expect(r).toEqual({ ok: true, spaceId: "spNEW", kind: "onetoone" });
    expect(g.workspaceCreateOneToOne).toHaveBeenCalledWith("USERID", "KEYX");
    expect(readConsole(f)?.spaceId).toBe("spNEW");
  });

  it("joins an invite link (no console written)", async () => {
    const g = { spaceJoin: vi.fn(async () => {}) } as any;
    const f = tmpConsole();
    const r = await bootstrapFromLink(g, "anytype://invite/?cid=C1&key=K1", f);
    expect(r).toEqual({ ok: true, spaceId: "", kind: "invite" });
    expect(g.spaceJoin).toHaveBeenCalledWith({ cid: "C1", key: "K1" });
    expect(readConsole(f)).toBeNull();
  });

  it("reports an error for junk input", async () => {
    const r = await bootstrapFromLink({} as any, "not a link", tmpConsole());
    expect(r.ok).toBe(false);
  });
});
