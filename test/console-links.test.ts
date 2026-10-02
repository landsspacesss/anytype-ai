import { describe, it, expect } from "vitest";
import { parseAnytypeLink } from "../src/console/links.js";

describe("parseAnytypeLink", () => {
  it("parses a 1:1 web link", () => {
    expect(parseAnytypeLink("https://hi.any.coop/AA5HkDmF#CAISIA7GAK")).toEqual({
      kind: "onetoone", identity: "AA5HkDmF", key: "CAISIA7GAK",
    });
  });
  it("parses a 1:1 deeplink", () => {
    expect(parseAnytypeLink("anytype://hi/?id=AA5HkDmF&key=CAISIA7GAK")).toEqual({
      kind: "onetoone", identity: "AA5HkDmF", key: "CAISIA7GAK",
    });
  });
  it("parses an invite deeplink", () => {
    expect(parseAnytypeLink("anytype://invite/?cid=bafyabc&key=zzz")).toEqual({
      kind: "invite", cid: "bafyabc", key: "zzz",
    });
  });
  it("parses an invite web link (non-hi host)", () => {
    expect(parseAnytypeLink("https://example.com/bafyabc#zzz")).toEqual({
      kind: "invite", cid: "bafyabc", key: "zzz",
    });
  });
  it("returns null for junk", () => {
    expect(parseAnytypeLink("hello world")).toBeNull();
    expect(parseAnytypeLink("https://hi.any.coop/onlyid")).toBeNull();
  });
});
