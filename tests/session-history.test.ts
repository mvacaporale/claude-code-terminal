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
