/**
 * Locate the contiguous run of buffer rows whose full-line text equals
 * anchorLines. Returns the start row of the match closest to preferredRow,
 * or null when the text is not on screen. All-blank anchors never match —
 * they would anchor to any empty region.
 */
export function findAnchorRow(
  bufferLines: string[],
  anchorLines: string[],
  preferredRow: number,
): number | null {
  if (anchorLines.length === 0) return null;
  if (anchorLines.every(line => line.trim().length === 0)) return null;

  let best: number | null = null;
  const maxStart = bufferLines.length - anchorLines.length;
  for (let row = 0; row <= maxStart; row++) {
    let matches = true;
    for (let i = 0; i < anchorLines.length; i++) {
      if (bufferLines[row + i] !== anchorLines[i]) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    if (best === null || Math.abs(row - preferredRow) < Math.abs(best - preferredRow)) {
      best = row;
    }
  }
  return best;
}
