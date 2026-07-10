import { exec } from "child_process";
import type { RemoteInfo } from "./types";

/**
 * SSH/tmux specifics for remote sessions. A remote tab is a local PTY
 * running `ssh -t <host>` attached to a named tmux session on the box,
 * so the terminal wiring (xterm, resize via SIGWINCH) is unchanged —
 * only the launch command and session-ID detection differ.
 */

const SSH_OPTS = "-o BatchMode=yes -o ConnectTimeout=5";

/** POSIX single-quote, safe at both the local- and remote-shell layers. */
export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Stable tmux session name for one tab. Only [a-z0-9-]: tmux targets
 * treat '.' and ':' as pane/window separators.
 */
export function makeTmuxName(): string {
  const rand = Math.random().toString(36).slice(2, 6);
  return `obs-${Date.now().toString(36)}-${rand}`;
}

/**
 * The single command written into the local PTY for a remote session.
 * `tmux new-session -A` covers every case: creates the session running
 * claude on first open; attaches (ignoring the command) when the session
 * already exists; recreates with `claude --resume` after a box reboot.
 * The trailing `exec bash -l` keeps the pane alive after claude exits.
 */
export function buildRemoteLaunchCommand(remote: RemoteInfo, claudeSessionId?: string | null): string {
  const safeId = claudeSessionId && /^[0-9a-fA-F-]+$/.test(claudeSessionId) ? claudeSessionId : null;
  const claudeCmd = safeId ? `claude --resume ${safeId}` : "claude";
  const remoteCmd =
    `tmux new-session -A -s ${remote.tmuxName} ` +
    `-c ${shellQuote(remote.path)} ` +
    `${shellQuote(claudeCmd + "; exec bash -l")}`;
  return `clear && ssh -t ${shellQuote(remote.host)} ${shellQuote(remoteCmd)}`;
}

/** Marks the boundary between PID-based output and the fallback dump. */
const FALLBACK_MARKER = "FALLBACK";
const RECORD_SEP = "\x1e";

/**
 * Remote script for one detection attempt: resolve the tmux pane's PID,
 * then look for a claude child (the pane runs `sh -c 'claude; ...'`, so
 * claude is a child or grandchild of pane_pid) and print its session file.
 * If that fails, dump all session files for client-side fallback filtering.
 */
function buildProbeScript(tmuxName: string): string {
  return [
    `p=$(tmux list-panes -t ${tmuxName} -F '#{pane_pid}' 2>/dev/null | head -1)`,
    `if [ -n "$p" ]; then`,
    `  for c in $(pgrep -P "$p"); do`,
    `    [ -f "$HOME/.claude/sessions/$c.json" ] && { cat "$HOME/.claude/sessions/$c.json"; exit 0; }`,
    `    for g in $(pgrep -P "$c"); do`,
    `      [ -f "$HOME/.claude/sessions/$g.json" ] && { cat "$HOME/.claude/sessions/$g.json"; exit 0; }`,
    `    done`,
    `  done`,
    `fi`,
    `echo ${FALLBACK_MARKER}`,
    `for f in "$HOME"/.claude/sessions/*.json; do printf '${RECORD_SEP}'; cat "$f"; done`,
  ].join("\n");
}

interface RemoteSessionFile {
  sessionId?: string;
  startedAt?: number;
  cwd?: string;
}

function parseSessionJson(raw: string): RemoteSessionFile | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * One detection attempt over SSH. Resolves the claude session ID or null
 * on any failure (unreachable host, no session file yet) — never throws,
 * so the bounded polling loop just runs out of attempts and gives up.
 */
export function probeRemoteSessionId(remote: RemoteInfo, launchTime: number): Promise<string | null> {
  return new Promise((resolve) => {
    const cmd = `ssh ${SSH_OPTS} ${shellQuote(remote.host)} ${shellQuote(buildProbeScript(remote.tmuxName))}`;
    exec(cmd, { timeout: 8000 }, (err, stdout) => {
      if (err || !stdout) { resolve(null); return; }

      const markerIdx = stdout.indexOf(FALLBACK_MARKER);
      if (markerIdx === -1) {
        resolve(parseSessionJson(stdout)?.sessionId ?? null);
        return;
      }

      // Fallback: newest session started in the remote working dir after
      // launch. 60s allowance covers local/remote clock skew.
      const candidates = stdout
        .slice(markerIdx + FALLBACK_MARKER.length)
        .split(RECORD_SEP)
        .map(parseSessionJson)
        .filter((d): d is RemoteSessionFile =>
          !!d?.sessionId && !!d.startedAt &&
          d.startedAt > launchTime - 60_000 &&
          !!d.cwd?.startsWith(remote.path)
        )
        .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
      resolve(candidates[0]?.sessionId ?? null);
    });
  });
}

/** Kill the remote tmux session (and whatever runs inside it). */
export function killRemoteTmuxSession(remote: RemoteInfo, cb: (err: Error | null) => void): void {
  const cmd = `ssh ${SSH_OPTS} ${shellQuote(remote.host)} ${shellQuote(`tmux kill-session -t ${remote.tmuxName}`)}`;
  exec(cmd, { timeout: 10000 }, (err) => cb(err ?? null));
}
