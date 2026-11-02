import { describe, it, expect } from "vitest";
import { isAutoSessionName } from "../src/session-history";

describe("isAutoSessionName", () => {
  it("matches auto-generated 'Session N' names", () => {
    expect(isAutoSessionName("Session 1")).toBe(true);
    expect(isAutoSessionName("Session 42")).toBe(true);
    expect(isAutoSessionName("Session 100")).toBe(true);
  });

  it("rejects user-supplied and malformed names", () => {
    expect(isAutoSessionName("Session")).toBe(false); // no number
    expect(isAutoSessionName("session 1")).toBe(false); // lowercase
    expect(isAutoSessionName("Session 1 (fork)")).toBe(false); // trailing text
    expect(isAutoSessionName("Session1")).toBe(false); // no space
    expect(isAutoSessionName("My Session 1")).toBe(false); // leading text
    expect(isAutoSessionName("Reading")).toBe(false);
    expect(isAutoSessionName("")).toBe(false);
  });
});

import { formatClosedAgo, recordClosedSession, removeClosedSession, MAX_RECENTLY_CLOSED } from "../src/session-history";
import type { ClosedSessionEntry } from "../src/types";

const closed = (over: Partial<ClosedSessionEntry>): ClosedSessionEntry => ({
  name: "Session 1", sessionId: "abc", userNamed: false, closedAt: 1000, ...over,
});

describe("recordClosedSession", () => {
  it("keeps unnamed tabs so they can be reopened", () => {
    const list = recordClosedSession([], closed({ name: "Session 3", sessionId: "s3" }));
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("Session 3");
  });

  it("skips tabs with nothing to resume", () => {
    const empty: ClosedSessionEntry[] = [];
    expect(recordClosedSession(empty, closed({ sessionId: undefined }))).toBe(empty);
  });

  it("keeps remote tabs without a session id", () => {
    const remote = { host: "miciato", path: "/v", tmuxName: "t1" };
    expect(recordClosedSession([], closed({ sessionId: undefined, remote }))).toHaveLength(1);
  });

  it("moves a re-closed conversation to the newest slot instead of duplicating it", () => {
    let list = recordClosedSession([], closed({ sessionId: "a", closedAt: 1 }));
    list = recordClosedSession(list, closed({ sessionId: "b", closedAt: 2 }));
    list = recordClosedSession(list, closed({ sessionId: "a", closedAt: 3 }));
    expect(list.map(e => e.sessionId)).toEqual(["b", "a"]);
  });

  it("caps the list, dropping the oldest", () => {
    let list: ClosedSessionEntry[] = [];
    for (let i = 0; i < MAX_RECENTLY_CLOSED + 3; i++) list = recordClosedSession(list, closed({ sessionId: `s${i}` }));
    expect(list).toHaveLength(MAX_RECENTLY_CLOSED);
    expect(list[0].sessionId).toBe("s3");
  });

  it("removes a reopened entry", () => {
    const list = [closed({ sessionId: "a" }), closed({ sessionId: "b" })];
    expect(removeClosedSession(list, closed({ sessionId: "a" })).map(e => e.sessionId)).toEqual(["b"]);
  });
});

describe("formatClosedAgo", () => {
  it("formats minutes, hours and days", () => {
    expect(formatClosedAgo(0, 30_000)).toBe("just now");
    expect(formatClosedAgo(0, 5 * 60_000)).toBe("5m ago");
    expect(formatClosedAgo(0, 3 * 3_600_000)).toBe("3h ago");
    expect(formatClosedAgo(0, 2 * 86_400_000)).toBe("2d ago");
  });
});
