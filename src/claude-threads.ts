import * as path from "path";
import type { RemoteInfo } from "./types";

/**
 * A single saved thread as stored inside a note's ```claude-threads block.
 * `session` is the Claude session id (null if detection never completed).
 * `archive` is the basename of the transcript copy under .claude/threads
 * (absent for remote threads, whose transcripts live on the remote host).
 */
export interface ThreadRef {
  name: string;
  session: string | null;
  cwd: string;
  remote?: RemoteInfo | null;
  archive?: string;
}

/** One named group = one ```claude-threads block. A note may hold several. */
export interface ThreadGroup {
  group: string;
  threads: ThreadRef[];
}

/** The info string that tags our fenced code block. */
export const THREADS_FENCE = "claude-threads";

/**
 * Claude Code names each project's transcript directory by replacing every
 * non-alphanumeric char in the cwd with "-". Verified against the real store:
 * ".../Lodestone/5. Code" -> "-Users-...-Lodestone-5--Code" (the ". " becomes "--").
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Absolute path to a local session's transcript: ~/.claude/projects/<enc(cwd)>/<id>.jsonl */
export function transcriptPath(homeDir: string, cwd: string, sessionId: string): string {
  return path.join(homeDir, ".claude", "projects", encodeProjectDir(cwd), `${sessionId}.jsonl`);
}

/**
 * The session id a saved thread should resume, or null to start fresh.
 * Local threads only resume when the transcript exists, so a stale id fails
 * visibly instead of with "No conversation found". Remote transcripts live on
 * the remote host and can't be checked here.
 */
export function resumeTarget(ref: ThreadRef, homeDir: string, exists: (p: string) => boolean): string | null {
  if (!ref.session) return null;
  if (ref.remote) return ref.session;
  return exists(transcriptPath(homeDir, ref.cwd, ref.session)) ? ref.session : null;
}

export function serializeThreadGroup(g: ThreadGroup): string {
  return JSON.stringify(g, null, 2);
}

/** Parse a block body back into a group, or null if it isn't a well-formed group. */
export function parseThreadGroup(body: string): ThreadGroup | null {
  try {
    const d = JSON.parse(body) as unknown;
    if (
      d && typeof d === "object" &&
      typeof (d as ThreadGroup).group === "string" &&
      Array.isArray((d as ThreadGroup).threads)
    ) {
      return d as ThreadGroup;
    }
  } catch { /* not JSON */ }
  return null;
}

/** The full fenced block (```claude-threads … ```) for a group. */
export function buildThreadBlock(g: ThreadGroup): string {
  return "```" + THREADS_FENCE + "\n" + serializeThreadGroup(g) + "\n```";
}

const BLOCK_RE = /```claude-threads\n([\s\S]*?)\n```/g;

/**
 * Insert or replace the ```claude-threads block for `g.group` in `content`,
 * leaving every other part of the note untouched. Matches on the parsed
 * group name so a note can carry several independently-updatable groups.
 */
export function upsertThreadGroup(content: string, g: ThreadGroup): string {
  const block = buildThreadBlock(g);
  BLOCK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BLOCK_RE.exec(content)) !== null) {
    const parsed = parseThreadGroup(m[1]);
    if (parsed && parsed.group === g.group) {
      return content.slice(0, m.index) + block + content.slice(m.index + m[0].length);
    }
  }
  // Not found — append, keeping exactly one blank line before the block.
  const sep = content.length === 0 ? "" : content.endsWith("\n\n") ? "" : content.endsWith("\n") ? "\n" : "\n\n";
  return content + sep + block + "\n";
}

/** All groups currently stored in a note. */
export function parseAllThreadGroups(content: string): ThreadGroup[] {
  const out: ThreadGroup[] = [];
  BLOCK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BLOCK_RE.exec(content)) !== null) {
    const g = parseThreadGroup(m[1]);
    if (g) out.push(g);
  }
  return out;
}
