import { describe, it, expect } from "vitest";
import { cleanPtyEnv } from "../src/pty-env";

describe("cleanPtyEnv", () => {
  it("drops session vars inherited from a parent Claude session", () => {
    const env = cleanPtyEnv({
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "85be8bbb",
      CLAUDE_CODE_CHILD_SESSION: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_EXECPATH: "/x/claude.exe",
      CLAUDE_EFFORT: "high",
    });
    expect(env).toEqual({});
  });

  it("keeps everything else, including user config and the plugin's own vars", () => {
    const env = cleanPtyEnv({
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "k",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_TERMINAL_TOKEN: "t",
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "k",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_TERMINAL_TOKEN: "t",
    });
  });

  it("does not mutate the input", () => {
    const src = { CLAUDECODE: "1" };
    cleanPtyEnv(src);
    expect(src).toEqual({ CLAUDECODE: "1" });
  });
});
