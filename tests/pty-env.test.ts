import { describe, it, expect } from "vitest";
import { cleanPtyEnv } from "../src/pty-env";

// What a Claude desktop-app session actually exports to its children (Nov 2026).
const DESKTOP_SESSION_VARS = [
  "CLAUDECODE", "CLAUDE_AGENT_SDK_MCP_NO_PREFIX", "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_CODE_ACCOUNT_UUID",
  "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_DESKTOP_APP_VERSION", "CLAUDE_CODE_DISABLE_CRON",
  "CLAUDE_CODE_DISABLE_TERMINAL_TITLE", "CLAUDE_CODE_EAGER_FLUSH", "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH", "CLAUDE_CODE_HOST_SESSION_ID", "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_SESSION_ACCESS_TOKEN", "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_SIMPLE", "CLAUDE_CODE_SSE_PORT", "CLAUDE_EFFORT", "CLAUDE_PID",
  "CLAUDE_PREVIEW_CLASSIFIER_FLOOR", "MCP_CONNECTION_NONBLOCKING", "MCP_SERVER_CONNECTION_BATCH_SIZE",
  "ANTHROPIC_BASE_URL",
];

describe("cleanPtyEnv", () => {
  it("drops everything a parent CLI session exports", () => {
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

  it("drops everything a parent desktop-app session exports, including its proxy URL", () => {
    const env = cleanPtyEnv({ ...Object.fromEntries(DESKTOP_SESSION_VARS.map(k => [k, "x"])), PATH: "/usr/bin" });
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  it("keeps a user's own ANTHROPIC_BASE_URL when nothing was inherited", () => {
    expect(cleanPtyEnv({ ANTHROPIC_BASE_URL: "https://proxy" })).toEqual({ ANTHROPIC_BASE_URL: "https://proxy" });
  });

  it("keeps unrelated vars and the plugin's own CLAUDE_TERMINAL_* vars", () => {
    const env = { PATH: "/usr/bin", ANTHROPIC_API_KEY: "k", CLAUDE_TERMINAL_TOKEN: "t", CLAUDE_CONFIG_DIR: "/c" };
    expect(cleanPtyEnv(env)).toEqual(env);
  });

  it("does not mutate the input", () => {
    const src = { CLAUDECODE: "1" };
    cleanPtyEnv(src);
    expect(src).toEqual({ CLAUDECODE: "1" });
  });
});
