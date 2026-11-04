/**
 * Variables a running Claude Code session exports to its children. If
 * Obsidian itself was launched from inside a Claude session (e.g. an agent
 * restarting it), Obsidian inherits them and every tab's `claude` believes
 * it is a child of that old session: it writes no ~/.claude/sessions/<pid>.json
 * (so the tab never learns its session id) and its transcript is not saved
 * (so `claude --resume` can't find it). Strip them before spawning the shell.
 */
const INHERITED_SESSION_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_EFFORT",
];

export function cleanPtyEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const key of INHERITED_SESSION_VARS) delete out[key];
  return out;
}
