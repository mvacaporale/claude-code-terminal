/**
 * Open a URL from terminal output in the system browser. Uses Electron's
 * shell via window.require (the pattern used elsewhere in this plugin) and
 * falls back to window.open if it isn't reachable.
 */
export function openExternalLink(uri: string): void {
  try {
    (window as unknown as {
      require: (m: string) => { shell: { openExternal(u: string): void } };
    }).require("electron").shell.openExternal(uri);
  } catch {
    window.open(uri, "_blank");
  }
}

/**
 * Clean up text copied from the terminal: normalize unicode whitespace,
 * trim trailing whitespace, dedent, and collapse blank-line runs.
 */
export function cleanCopyText(text: string): string {
  // 0. Normalize all unicode whitespace (nbsp, en-space, etc) to regular space.
  //    Claude Code often emits these for layout, which breaks naive dedent.
  const normalized = text.replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, " ");

  // 1. Trim trailing whitespace per line
  let lines = normalized.split("\n").map(l => l.replace(/[ \t]+$/g, ""));

  // 2. Dedent — strip the common leading whitespace from all non-empty lines
  let minIndent = Infinity;
  for (const line of lines) {
    if (line === "") continue;
    const match = line.match(/^[ \t]*/);
    const indent = match ? match[0].length : 0;
    if (indent < minIndent) minIndent = indent;
    if (minIndent === 0) break;
  }
  if (minIndent > 0 && minIndent !== Infinity) {
    lines = lines.map(l => (l === "" ? l : l.slice(minIndent)));
  }

  // 3. Collapse runs of 3+ blank lines down to 2
  const out: string[] = [];
  let blankRun = 0;
  for (const line of lines) {
    if (line === "") {
      blankRun++;
      if (blankRun <= 2) out.push(line);
    } else {
      blankRun = 0;
      out.push(line);
    }
  }

  // 4. Trim leading/trailing blank lines from the whole selection
  while (out.length && out[0] === "") out.shift();
  while (out.length && out[out.length - 1] === "") out.pop();

  return out.join("\n");
}

let colorCtx: CanvasRenderingContext2D | null = null;

/**
 * Normalize any CSS color string (hsla, named colors, etc) to a form
 * xterm's parser accepts (#rrggbb or rgba()). Obsidian theme variables
 * like --text-selection often resolve to hsla(), which xterm rejects.
 * Returns null for empty or invalid input.
 */
export function normalizeCssColor(color: string): string | null {
  if (!color) return null;
  if (!colorCtx) colorCtx = document.createElement("canvas").getContext("2d");
  if (!colorCtx) return null;
  colorCtx.fillStyle = "#010203"; // sentinel to detect invalid input
  colorCtx.fillStyle = color;
  const normalized = colorCtx.fillStyle;
  if (normalized === "#010203" && color.toLowerCase() !== "#010203") return null;
  return normalized;
}

/**
 * Convert a hex color (#abc or #aabbcc) to an rgba() string.
 * Returns null if the input is not a valid hex color.
 */
export function hexToRgba(hex: string, alpha: number): string | null {
  const match = hex.trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!match) return null;
  let h = match[1];
  if (h.length === 3) h = h.split("").map(c => c + c).join("");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
