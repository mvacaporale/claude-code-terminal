import { describe, it, expect } from "vitest";
import { buildLocalLaunchCommand } from "../src/launch-command";

const base = { initialInput: undefined, resume: false, fork: false, claudeSessionId: null, isFirstSession: false };

describe("buildLocalLaunchCommand", () => {
  it("forks with --fork-session when resuming a session with a fork request", () => {
    expect(
      buildLocalLaunchCommand({ ...base, resume: true, fork: true, claudeSessionId: "abc-123" })
    ).toBe("clear && claude --resume abc-123 --fork-session");
  });

  it("resumes without --fork-session for a normal restore", () => {
    expect(
      buildLocalLaunchCommand({ ...base, resume: true, fork: false, claudeSessionId: "abc-123" })
    ).toBe("clear && claude --resume abc-123");
  });

  it("ignores fork when there is no session id to fork from", () => {
    expect(buildLocalLaunchCommand({ ...base, resume: true, fork: true, claudeSessionId: null })).toBe(
      "clear && claude --continue"
    );
  });

  it("continues on the first session", () => {
    expect(buildLocalLaunchCommand({ ...base, isFirstSession: true })).toBe("clear && claude --continue");
  });

  it("starts fresh for a review session with initial input, even if fork is set", () => {
    expect(
      buildLocalLaunchCommand({ ...base, initialInput: "hi", resume: true, fork: true, claudeSessionId: "abc" })
    ).toBe("clear && claude");
  });

  it("starts a plain session otherwise", () => {
    expect(buildLocalLaunchCommand(base)).toBe("clear && claude");
  });
});
