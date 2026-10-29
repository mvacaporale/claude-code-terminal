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
 * Local detection: PID-based lookup first (child process →
 * ~/.claude/sessions/<pid>.json), then a fallback scan of the sessions
 * dir for files created after launch with a matching cwd. `isClaimed` marks
 * ids already held by other open tabs, which the fallback must skip.
 */
export function makeLocalProbe(
  shellPid: number,
  vaultPath: string,
  launchTime: number,
  isClaimed: (sessionId: string) => boolean,
): () => Promise<string | null> {
  return async () =>
    (await tryPidBased(shellPid)) ?? (await tryFallback(vaultPath, launchTime, isClaimed));
}

/**
 * Newest candidate not already held by another tab. Without the claim check,
 * tabs launched together (restore, "Reopen all") all grabbed the same newest
 * session, so one id ended up mapped to several tab names.
 */
export function pickFallbackSession(
  candidates: { sessionId: string; startedAt: number }[],
  isClaimed: (sessionId: string) => boolean,
): string | null {
  const free = candidates.filter(c => !isClaimed(c.sessionId));
  free.sort((a, b) => b.startedAt - a.startedAt);
  return free[0]?.sessionId ?? null;
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

async function readSessionFile(filePath: string): Promise<{ sessionId?: string; startedAt?: number; cwd?: string } | null> {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf-8"));
  } catch {
    return null; // missing or malformed
  }
}

async function tryPidBased(shellPid: number): Promise<string | null> {
  for (const pid of await pgrepChildren(shellPid)) {
    const data = await readSessionFile(path.join(SESSIONS_DIR, `${pid}.json`));
    if (data?.sessionId) return data.sessionId;
  }
  return null;
}

async function tryFallback(vaultPath: string, launchTime: number, isClaimed: (sessionId: string) => boolean): Promise<string | null> {
  try {
    const files = (await fsp.readdir(SESSIONS_DIR)).filter(f => f.endsWith(".json"));
    const candidates: { sessionId: string; startedAt: number }[] = [];
    for (const f of files) {
      const data = await readSessionFile(path.join(SESSIONS_DIR, f));
      if (data?.sessionId && data.startedAt && data.startedAt > launchTime && data.cwd?.startsWith(vaultPath)) {
        candidates.push({ sessionId: data.sessionId, startedAt: data.startedAt });
      }
    }
    return pickFallbackSession(candidates, isClaimed);
  } catch {
    return null;
  }
}
