import { exec } from "child_process";
import { promises as fsp } from "fs";
import * as path from "path";

const SESSIONS_DIR = path.join(process.env.HOME || "", ".claude", "sessions");

interface DetectOptions {
  /** PID of the shell the terminal spawned (claude runs as its child). */
  shellPid: number;
  /** Vault base path, used to match session files by cwd. */
  vaultPath: string;
  /** Return true once the session ID is known (stops further attempts). */
  isSettled: () => boolean;
  onDetected: (sessionId: string) => void;
}

/**
 * Poll for the Claude session ID after launch. Tries PID-based lookup
 * first (child process → ~/.claude/sessions/<pid>.json), then falls back
 * to scanning the sessions dir for files created after launch with a
 * matching cwd. All I/O is async so the UI thread is never blocked.
 */
export function watchForClaudeSessionId(options: DetectOptions): void {
  const launchTime = Date.now();

  const attempt = (n: number) => {
    if (n > 5 || options.isSettled()) return;
    setTimeout(() => {
      void (async () => {
        if (options.isSettled()) return;

        const sessionId =
          (await tryPidBased(options.shellPid)) ??
          (await tryFallback(options.vaultPath, launchTime));

        if (sessionId) {
          options.onDetected(sessionId);
          return;
        }
        attempt(n + 1);
      })();
    }, 2000 + n * 2000);
  };

  attempt(0);
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

async function tryFallback(vaultPath: string, launchTime: number): Promise<string | null> {
  try {
    const files = (await fsp.readdir(SESSIONS_DIR)).filter(f => f.endsWith(".json"));
    const candidates: { sessionId: string; startedAt: number }[] = [];
    for (const f of files) {
      const data = await readSessionFile(path.join(SESSIONS_DIR, f));
      if (data?.sessionId && data.startedAt && data.startedAt > launchTime && data.cwd?.startsWith(vaultPath)) {
        candidates.push({ sessionId: data.sessionId, startedAt: data.startedAt });
      }
    }
    candidates.sort((a, b) => b.startedAt - a.startedAt);
    return candidates[0]?.sessionId ?? null;
  } catch {
    return null;
  }
}
