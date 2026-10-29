import * as path from "path";

/**
 * Where a screenshot pasted from the clipboard is saved before its path is
 * handed to Claude Code (which attaches an image when a file path is pasted),
 * e.g. <dir>/claude-paste-20261029-094955-123.png.
 */
export function pastedImagePath(dir: string, now: Date, mime: string): string {
  const ext = (mime.split("/")[1] || "png").replace("jpeg", "jpg").replace(/[^a-z0-9]/gi, "");
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}`;
  return path.join(dir, `claude-paste-${stamp}.${ext}`);
}

/**
 * The clipboard item to treat as a pasted image, or null to let xterm paste
 * normally. Text wins, so copying text that also carries an image still
 * pastes as text.
 */
export function pickPastedImage<T extends { kind: string; type: string }>(items: T[]): T | null {
  if (items.some(i => i.kind === "string" && i.type === "text/plain")) return null;
  return items.find(i => i.kind === "file" && i.type.startsWith("image/")) ?? null;
}
