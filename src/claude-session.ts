import { exec } from "child_process";
import { promises as fsp } from "fs";
import * as path from "path";

const SESSIONS_DIR = path.join(process.env.HOME || "", ".claude", "sessions");

interface DetectOptions {
  /** One detection attempt; resolves the session ID or null. */
  probe: () => Promise<string | null>;
  /** Return true once the session ID is known (stops further attempts). */
  isSettled: () => boolean;
  onDetected: (sessionId: string) => void;
}

/**
 * Poll for the Claude session ID after launch using the supplied probe
 * (local filesystem lookup or an SSH round-trip for remote sessions).
 * All I/O is async so the UI thread is never blocked.
 */
export function watchForClaudeSessionId(options: DetectOptions): void {
  const attempt = (n: number) => {
    if (n > 5 || options.isSettled()) return;
    setTimeout(() => {
      void (async () => {
        if (options.isSettled()) return;

        const sessionId = await options.probe();

        if (sessionId) {
          options.onDetected(sessionId);
          // onDetected may reject the id (e.g. a stale read of the pre-resume
          // session); keep polling until the caller reports settled.
          if (options.isSettled()) return;
        }
        attempt(n + 1);
      })();
    }, 2000 + n * 2000);
  };

  attempt(0);
}

/**
 * Local detection: the Claude process somewhere under this tab's shell writes
 * ~/.claude/sessions/<pid>.json, and that file always names the conversation
 * it is in right now (it changes on /clear and /resume). Only this tab's own
 * process tree is searched: the old fallback took the newest session in the
 * vault, which could belong to another tab or to a background job, and saved
 * the tab under the wrong conversation.
 */
export function makeLocalProbe(shellPid: number, launchedAt: number): () => Promise<string | null> {
  return () => findSessionInTree(shellPid, pgrepChildren, (pid) => readSessionIdForPid(pid, launchedAt));
}

/**
 * Breadth-first search of `rootPid`'s descendants for the first process with
 * a session file. Claude is not always a direct child of the shell (wrapper
 * scripts, npx), so a few levels are walked.
 */
export async function findSessionInTree(
  rootPid: number,
  children: (pid: number) => Promise<string[]>,
  readSessionId: (pid: string) => Promise<string | null>,
  maxDepth = 4,
): Promise<string | null> {
  let level = await children(rootPid);
  for (let depth = 1; depth <= maxDepth && level.length > 0; depth++) {
    const next: string[] = [];
    for (const pid of level) {
      const sessionId = await readSessionId(pid);
      if (sessionId) return sessionId;
      next.push(...(await children(Number(pid))));
    }
    level = next;
  }
  return null;
}

function pgrepChildren(pid: number): Promise<string[]> {
  return new Promise((resolve) => {
    // pgrep returns non-zero when no children are found
    exec(`pgrep -P ${pid}`, { timeout: 2000 }, (err, stdout) => {
      if (err) { resolve([]); return; }
      resolve(stdout.trim().split("\n").filter(p => p.length > 0));
    });
  });
}

interface SessionFile {
  sessionId?: unknown;
  kind?: unknown;
  startedAt?: unknown;
}

/** Slack for clock skew between the tab's launch and Claude's own startedAt. */
const STARTED_AT_SLACK_MS = 5000;

/**
 * Whether a session file belongs to the tab's own interactive Claude.
 * Background jobs, SDK runs (`claude -p` from hooks or scripts) and stale files
 * left behind by a killed process whose pid was later reused all write
 * session files too; taking their id saves the tab under someone else's
 * conversation.
 */
export function sessionIdFromFile(data: SessionFile | null, launchedAt: number): string | null {
  if (!data || typeof data.sessionId !== "string" || !data.sessionId) return null;
  if (data.kind !== undefined && data.kind !== "interactive") return null;
  if (typeof data.startedAt === "number" && data.startedAt < launchedAt - STARTED_AT_SLACK_MS) return null;
  return data.sessionId;
}

async function readSessionFile(filePath: string): Promise<SessionFile | null> {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf-8"));
  } catch {
    return null; // missing or malformed
  }
}

async function readSessionIdForPid(pid: string, launchedAt: number): Promise<string | null> {
  return sessionIdFromFile(await readSessionFile(path.join(SESSIONS_DIR, `${pid}.json`)), launchedAt);
}
