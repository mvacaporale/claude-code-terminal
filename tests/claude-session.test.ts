import { describe, expect, it } from "vitest";
import { findSessionInTree, sessionIdFromFile } from "../src/claude-session";

// A fake process tree: pid -> child pids, and pids that have a session file.
function tree(edges: Record<number, string[]>, sessions: Record<string, string>) {
  return {
    children: async (pid: number) => edges[pid] ?? [],
    readSessionId: async (pid: string) => sessions[pid] ?? null,
  };
}

describe("findSessionInTree", () => {
  it("finds Claude as a direct child of the tab's shell", async () => {
    const t = tree({ 100: ["101"] }, { "101": "abc" });
    expect(await findSessionInTree(100, t.children, t.readSessionId)).toBe("abc");
  });

  it("finds Claude under a wrapper process", async () => {
    const t = tree({ 100: ["101"], 101: ["102"] }, { "102": "wrapped" });
    expect(await findSessionInTree(100, t.children, t.readSessionId)).toBe("wrapped");
  });

  it("never returns a session from outside the tab's own process tree", async () => {
    // 200 is another tab or a background job; its session must not be picked.
    const t = tree({ 100: ["101"], 200: ["201"] }, { "201": "someone-else" });
    expect(await findSessionInTree(100, t.children, t.readSessionId)).toBeNull();
  });

  it("returns null when Claude isn't running in the tab", async () => {
    const t = tree({}, {});
    expect(await findSessionInTree(100, t.children, t.readSessionId)).toBeNull();
  });

  it("stops at the depth limit", async () => {
    const t = tree({ 1: ["2"], 2: ["3"], 3: ["4"] }, { "4": "deep" });
    expect(await findSessionInTree(1, t.children, t.readSessionId, 2)).toBeNull();
    expect(await findSessionInTree(1, t.children, t.readSessionId, 3)).toBe("deep");
  });
});

describe("sessionIdFromFile", () => {
  const launched = 1_000_000;
  it("takes the interactive session started after the tab launched", () => {
    expect(sessionIdFromFile({ sessionId: "a", kind: "interactive", startedAt: launched + 10 }, launched)).toBe("a");
  });
  it("accepts older files that carry no kind or startedAt", () => {
    expect(sessionIdFromFile({ sessionId: "a" }, launched)).toBe("a");
  });
  it("skips background jobs and SDK runs", () => {
    expect(sessionIdFromFile({ sessionId: "a", kind: "job", startedAt: launched + 10 }, launched)).toBeNull();
    expect(sessionIdFromFile({ sessionId: "a", kind: "sdk", startedAt: launched + 10 }, launched)).toBeNull();
    expect(sessionIdFromFile({ sessionId: "a", kind: "background", startedAt: launched + 10 }, launched)).toBeNull();
  });
  it("skips a stale file from before the tab launched (reused pid)", () => {
    expect(sessionIdFromFile({ sessionId: "a", kind: "interactive", startedAt: launched - 60_000 }, launched)).toBeNull();
  });
  it("skips missing or malformed files", () => {
    expect(sessionIdFromFile(null, launched)).toBeNull();
    expect(sessionIdFromFile({ sessionId: 42 }, launched)).toBeNull();
  });
});
