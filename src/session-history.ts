import type { ClosedSessionEntry } from "./types";

/** True for auto-generated tab names like "Session 1" — tabs the user never
 * named. Only user-named tabs are persisted, so these are dropped on save and
 * pruned from any legacy persisted/history entries on load. */
export function isAutoSessionName(name: string): boolean {
  return /^Session \d+$/.test(name);
}

/** How many recently closed tabs are kept for reopening. */
export const MAX_RECENTLY_CLOSED = 10;

/**
 * Record a just-closed tab (named or not) so it can be reopened. Newest last;
 * the same conversation (or remote tmux session) only appears once, and the
 * list is capped. Tabs with nothing to resume are skipped. Pure, for tests.
 */
export function recordClosedSession(
  list: ClosedSessionEntry[],
  entry: ClosedSessionEntry,
  max = MAX_RECENTLY_CLOSED,
): ClosedSessionEntry[] {
  if (!entry.sessionId && !entry.remote) return list;
  const key = closedKey(entry);
  const next = list.filter(e => closedKey(e) !== key);
  next.push(entry);
  return next.length > max ? next.slice(next.length - max) : next;
}

/** Drop a recently closed entry (after it has been reopened). */
export function removeClosedSession(list: ClosedSessionEntry[], entry: ClosedSessionEntry): ClosedSessionEntry[] {
  const key = closedKey(entry);
  return list.filter(e => closedKey(e) !== key);
}

function closedKey(e: ClosedSessionEntry): string {
  return e.remote ? `remote:${e.remote.host}:${e.remote.tmuxName}` : `local:${e.sessionId}`;
}

/** "just now", "5m ago", "3h ago", "2d ago". */
export function formatClosedAgo(closedAt: number, now: number): string {
  const mins = Math.floor(Math.max(0, now - closedAt) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
