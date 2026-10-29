import { describe, expect, it } from "vitest";
import { pastedImagePath, pickPastedImage } from "../src/image-paste";

describe("pastedImagePath", () => {
  const now = new Date(2026, 9, 29, 9, 49, 55, 7);
  it("timestamps the file and keeps the image type", () => {
    expect(pastedImagePath("/tmp", now, "image/png")).toBe("/tmp/claude-paste-20261029-094955-007.png");
  });
  it("uses .jpg for jpeg", () => {
    expect(pastedImagePath("/tmp", now, "image/jpeg")).toMatch(/\.jpg$/);
  });
});

describe("pickPastedImage", () => {
  const png = { kind: "file", type: "image/png" };
  const text = { kind: "string", type: "text/plain" };
  it("picks an image when there's no text", () => {
    expect(pickPastedImage([png])).toBe(png);
  });
  it("leaves text pastes to xterm", () => {
    expect(pickPastedImage([text, png])).toBeNull();
    expect(pickPastedImage([text])).toBeNull();
  });
});
