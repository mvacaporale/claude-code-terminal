import * as fs from "fs";
import * as path from "path";

/**
 * obsidian:// links the agent running inside a terminal tab can open to drive
 * the plugin: start a new tab with a prompt, or file feedback. Every link must
 * carry the install's secret token, which only reaches the agent through the
 * pty environment, so a link on a web page or in a note can't trigger either.
 * Kept free of Obsidian imports so it can be unit-tested.
 */

export const NEW_TAB_ACTION = "claude-new-tab";
export const FEEDBACK_ACTION = "claude-feedback";
export const TOKEN_ENV = "CLAUDE_TERMINAL_TOKEN";
export const RECEIPT_ENV = "CLAUDE_TERMINAL_RECEIPT";
export const SKILL_NAME = "obsidian-terminal";

export type LinkParams = Record<string, string | undefined>;

export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

/** Constant-time-ish compare; both sides are short hex strings. */
export function tokenMatches(params: LinkParams, expected: string): boolean {
  const got = params.token ?? "";
  if (!expected || got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export function parseNewTab(params: LinkParams, expected: string): Parsed<{ prompt: string; name?: string }> {
  if (!tokenMatches(params, expected)) return { ok: false, reason: "missing or wrong token" };
  const prompt = (params.prompt ?? "").trim();
  if (!prompt) return { ok: false, reason: "missing prompt" };
  const name = (params.name ?? "").trim();
  return { ok: true, value: name ? { prompt, name } : { prompt } };
}

export function parseFeedback(params: LinkParams, expected: string): Parsed<{ text: string }> {
  if (!tokenMatches(params, expected)) return { ok: false, reason: "missing or wrong token" };
  const text = (params.text ?? "").trim();
  if (!text) return { ok: false, reason: "missing text" };
  return { ok: true, value: { text } };
}

/** Best-effort JSON receipt the agent reads back to confirm a link worked. */
export function writeLinkReceipt(file: string, data: Record<string, unknown>, now = new Date()): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...data, at: now.toISOString() }, null, 2));
  } catch {
    /* receipt is best-effort */
  }
}

/** Where the skill is installed: the vault's project skills, which Claude Code loads from its cwd. */
export function skillPath(vaultPath: string): string {
  return path.join(vaultPath, ".claude", "skills", SKILL_NAME, "SKILL.md");
}

/** Write the skill if it's missing or out of date. Returns true when it wrote. */
export function installSkill(vaultPath: string): boolean {
  const file = skillPath(vaultPath);
  try {
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === SKILL_MD) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, SKILL_MD);
    return true;
  } catch {
    return false;
  }
}

// quote_via=quote: Obsidian decodes params with decodeURIComponent, which leaves "+" as-is.
const OPEN_LINK = `python3 -c 'import os,sys,subprocess,urllib.parse as u; a=sys.argv; subprocess.run(["open", "obsidian://"+a[1]+"?"+u.urlencode(dict([("token", os.environ["${TOKEN_ENV}"])]+[p.split("=",1) for p in a[2:]]), quote_via=u.quote)], check=True)'`;

export const SKILL_MD = `---
name: ${SKILL_NAME}
description: Open a new Claude tab in the Obsidian terminal plugin with a prompt (to delegate a task), or file feedback about the plugin. Use when asked to hand work to a new tab or to report a plugin bug or idea.
---

<!-- Installed and kept up to date by the Claude Obsidian Plugin; edits are overwritten on reload. -->

These only work in a local tab of the Obsidian terminal plugin, where \`$${TOKEN_ENV}\` is set.
If it is empty, say so instead of trying (remote tabs and plain terminals don't have it).

## Delegate a task to a new tab

Write a self-contained prompt (the new tab has none of this conversation), then:

\`\`\`bash
${OPEN_LINK} ${NEW_TAB_ACTION} "name=Short tab name" "prompt=The full prompt"
\`\`\`

The tab opens, starts a fresh \`claude\`, and submits the prompt. \`name\` is optional.

## File feedback about the plugin

When the user asks you to log a bug or idea for the plugin (or you hit a plugin bug they want tracked):

\`\`\`bash
${OPEN_LINK} ${FEEDBACK_ACTION} "text=One-line title

Details: what happened, what was expected, steps."
\`\`\`

The first line becomes the issue title. It is filed as a GitHub issue in the user's private feedback repo.

## Confirm

Both actions write a receipt. Wait a second, then read it:

\`\`\`bash
cat "$${RECEIPT_ENV}"
\`\`\`

\`"ok": true\` means it worked (feedback receipts include the issue \`url\`). Otherwise \`reason\` says why.
`;
