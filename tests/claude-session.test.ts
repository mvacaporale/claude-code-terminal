import { describe, expect, it } from "vitest";
import { pickFallbackSession } from "../src/claude-session";

describe("pickFallbackSession", () => {
  const candidates = [
    { sessionId: "older", startedAt: 1 },
    { sessionId: "newest", startedAt: 3 },
    { sessionId: "middle", startedAt: 2 },
  ];

  it("picks the newest session when none is claimed", () => {
    expect(pickFallbackSession(candidates, () => false)).toBe("newest");
  });

  it("skips sessions other tabs already hold", () => {
    const claimed = new Set(["newest"]);
    expect(pickFallbackSession(candidates, id => claimed.has(id))).toBe("middle");
  });

  it("returns null when every candidate is claimed", () => {
    expect(pickFallbackSession(candidates, () => true)).toBeNull();
  });
});
