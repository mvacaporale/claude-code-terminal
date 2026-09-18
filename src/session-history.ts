/** True for auto-generated tab names like "Session 1" — tabs the user never
 * named. Only user-named tabs are persisted, so these are dropped on save and
 * pruned from any legacy persisted/history entries on load. */
export function isAutoSessionName(name: string): boolean {
  return /^Session \d+$/.test(name);
}
