import { describe, it, expect } from "vitest";
import { sanitize } from "../src/util/sanitize.js";

describe("sanitize", () => {
  it("leaves filesystem-safe base32-ish ids unchanged", () => {
    expect(sanitize("sp-abc")).toBe("sp-abc");
    expect(sanitize("BOTIDENTITY_PLACEHOLDER_xxxxxxxx")).toBe("BOTIDENTITY_PLACEHOLDER_xxxxxxxx");
    expect(sanitize("a.b_c-d")).toBe("a.b_c-d");
  });

  it("replaces anything outside [A-Za-z0-9._-] with _", () => {
    expect(sanitize("a b/c\\d:e")).toBe("a_b_c_d_e");
    expect(sanitize("../../etc/passwd")).toBe(".._.._etc_passwd");
    expect(sanitize("héllo@wörld")).toBe("h_llo_w_rld");
  });

  it("caps the length (default 80)", () => {
    const long = "x".repeat(200);
    expect(sanitize(long).length).toBe(80);
    expect(sanitize(long, 10)).toBe("x".repeat(10));
  });

  it("handles the empty string", () => {
    expect(sanitize("")).toBe("");
  });
});
