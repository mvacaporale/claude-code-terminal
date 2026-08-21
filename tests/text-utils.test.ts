import { describe, it, expect, vi, afterEach } from "vitest";
import { openExternalLink } from "../src/text-utils";

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  vi.restoreAllMocks();
});

describe("openExternalLink", () => {
  it("falls back to window.open when Electron shell is unreachable", () => {
    // require("electron") is unavailable in the test env, so the fallback runs.
    const open = vi.fn();
    (globalThis as { window?: unknown }).window = { open };
    openExternalLink("https://example.com/path?q=1");
    expect(open).toHaveBeenCalledWith("https://example.com/path?q=1", "_blank");
  });
});
