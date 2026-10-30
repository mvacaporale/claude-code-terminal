/**
 * Side-by-side layout: two tabs shown at once, left and right. The active tab
 * is always one of the pair; picking a tab outside the pair swaps it into the
 * active side. Pure functions so vitest can cover the rules.
 */
export interface SplitPair {
  left: string;
  right: string;
}

/** Show `id` beside the active tab. Null when there's nothing to pair. */
export function openSplit(activeId: string | null, id: string): SplitPair | null {
  if (!activeId || activeId === id) return null;
  return { left: activeId, right: id };
}

/** The pair after switching to `id`: unchanged if it's already shown, else `id` replaces the active side. */
export function switchInSplit(split: SplitPair | null, activeId: string | null, id: string): SplitPair | null {
  if (!split) return null;
  if (split.left === id || split.right === id) return split;
  if (split.left === activeId) return { left: id, right: split.right };
  if (split.right === activeId) return { left: split.left, right: id };
  return null;
}

/** Closing either side ends the split. */
export function dropFromSplit(split: SplitPair | null, id: string): SplitPair | null {
  return split && (split.left === id || split.right === id) ? null : split;
}

export function inSplit(split: SplitPair | null, id: string): boolean {
  return !!split && (split.left === id || split.right === id);
}
