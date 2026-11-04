/**
 * Variables a running Claude Code session exports to its children. If
 * Obsidian itself was launched from inside a Claude session (e.g. an agent
 * restarting it), Obsidian inherits them and every tab's `claude` believes
 * it is a child of that old session: it writes no ~/.claude/sessions/<pid>.json
 * (so the tab never learns its session id) and its transcript is not saved
 * (so `claude --resume` can't find it). A Claude desktop-app session also
 * exports host sockets, auth tokens and a local proxy URL that die with it.
 *
 * Matched by prefix because each Claude release adds more of them. Anything a
 * user configures in their shell rc files comes back when the tab's shell
 * starts, so stripping a real setting here costs nothing.
 */
const INHERITED_SESSION_VAR = /^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_AGENT_SDK_|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_PREVIEW_|MCP_CONNECTION_|MCP_SERVER_CONNECTION_)/;

/** Only trusted when we know the env came from a Claude session (it may be a desktop-app proxy). */
const SESSION_ONLY_WHEN_INHERITED = ["ANTHROPIC_BASE_URL"];

export function cleanPtyEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const inherited = "CLAUDECODE" in env;
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (INHERITED_SESSION_VAR.test(key)) continue;
    if (inherited && SESSION_ONLY_WHEN_INHERITED.includes(key)) continue;
    out[key] = value;
  }
  return out;
}
