import { describe, expect, it } from "vitest";
import { findAnchorRow } from "../src/anchor";

const screen = (...lines: string[]) => lines;

describe("findAnchorRow", () => {
  it("finds a single-line anchor at its row", () => {
    const buf = screen("alpha", "bravo", "charlie");
    expect(findAnchorRow(buf, ["bravo"], 0)).toBe(1);
  });

  it("finds a multi-line anchor run", () => {
    const buf = screen("x", "alpha", "bravo", "charlie", "y");
    expect(findAnchorRow(buf, ["alpha", "bravo", "charlie"], 0)).toBe(1);
  });

  it("returns null when the text scrolled off screen", () => {
    const buf = screen("delta", "echo");
    expect(findAnchorRow(buf, ["alpha"], 0)).toBeNull();
  });

  it("tracks the anchor after the content shifts (scroll)", () => {
    const before = screen("head", "target line", "tail");
    const after = screen("target line", "tail", "new line");
    expect(findAnchorRow(before, ["target line"], 1)).toBe(1);
    expect(findAnchorRow(after, ["target line"], 1)).toBe(0);
  });

  it("prefers the match closest to the previous row when duplicated", () => {
    const buf = screen("dup", "a", "b", "dup", "c");
    expect(findAnchorRow(buf, ["dup"], 4)).toBe(3);
    expect(findAnchorRow(buf, ["dup"], 0)).toBe(0);
  });

  it("never matches an all-blank anchor", () => {
    const buf = screen("", "", "");
    expect(findAnchorRow(buf, ["", ""], 0)).toBeNull();
    expect(findAnchorRow(buf, [], 0)).toBeNull();
  });

  it("requires the full run to match, not just the first line", () => {
    const buf = screen("alpha", "CHANGED", "charlie");
    expect(findAnchorRow(buf, ["alpha", "bravo"], 0)).toBeNull();
  });

  it("returns null when the anchor is taller than the screen", () => {
    expect(findAnchorRow(screen("a"), ["a", "b"], 0)).toBeNull();
  });
});
