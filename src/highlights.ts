import { Notice, setIcon } from "obsidian";
import * as path from "path";
import * as fs from "fs";
import type { ClaudeTerminalSettings, TerminalHighlight, TerminalSession } from "./types";
import { hexToRgba } from "./text-utils";

const HIGHLIGHT_ALPHA = 0.35;
const FALLBACK_HIGHLIGHT_COLOR = "rgba(250, 200, 50, 0.35)";

/**
 * Owns highlight creation, rendering, and the hover popup for terminal sessions.
 * Highlight state itself lives on each TerminalSession.
 */
export class HighlightController {
  constructor(private getSettings: () => ClaudeTerminalSettings) {}

  createFromSelection(session: TerminalSession) {
    const selection = session.terminal.getSelection();
    if (!selection || selection.trim().length === 0) return;

    const selectionPosition = session.terminal.getSelectionPosition();
    if (!selectionPosition) return;

    // xterm.js getSelectionPosition() returns 0-based buffer coords (the
    // "1-based" note in xterm.d.ts is stale — the impl stores raw 0-based).
    let startLine = selectionPosition.start.y;
    let startCol = selectionPosition.start.x;
    let endLine = selectionPosition.end.y;
    let endCol = selectionPosition.end.x;

    // Find and merge overlapping highlights
    const overlapping: TerminalHighlight[] = [];
    for (const h of session.highlights) {
      // Two ranges overlap if one starts before the other ends
      const hBefore = h.endLine < startLine || (h.endLine === startLine && h.endCol < startCol);
      const hAfter = h.startLine > endLine || (h.startLine === endLine && h.startCol > endCol);
      if (!hBefore && !hAfter) {
        overlapping.push(h);
      }
    }

    // Expand range to cover all overlapping highlights
    for (const h of overlapping) {
      if (h.startLine < startLine || (h.startLine === startLine && h.startCol < startCol)) {
        startLine = h.startLine;
        startCol = h.startCol;
      }
      if (h.endLine > endLine || (h.endLine === endLine && h.endCol > endCol)) {
        endLine = h.endLine;
        endCol = h.endCol;
      }
      // Remove the old highlight
      this.disposeHighlight(h);
      session.highlights = session.highlights.filter(x => x.id !== h.id);
    }

    // Rebuild the full text from the terminal buffer
    const buffer = session.terminal.buffer.active;
    const lines: string[] = [];
    for (let line = startLine; line <= endLine; line++) {
      const bufferLine = buffer.getLine(line);
      if (!bufferLine) { lines.push(""); continue; }
      const fullText = bufferLine.translateToString(true);
      if (line === startLine && line === endLine) {
        lines.push(fullText.substring(startCol, endCol));
      } else if (line === startLine) {
        lines.push(fullText.substring(startCol));
      } else if (line === endLine) {
        lines.push(fullText.substring(0, endCol));
      } else {
        lines.push(fullText);
      }
    }

    const highlight: TerminalHighlight = {
      id: `hl-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
      text: lines.join("\n"),
      timestamp: Date.now(),
      startLine,
      startCol,
      endLine,
      endCol,
      decorations: [],
      markers: [],
    };

    this.render(session, highlight);
    session.highlights.push(highlight);
    session.terminal.clearSelection();
  }

  remove(session: TerminalSession, id: string) {
    const index = session.highlights.findIndex(h => h.id === id);
    if (index === -1) return;

    const highlight = session.highlights[index];
    this.disposeHighlight(highlight);
    session.highlights.splice(index, 1);
    this.hidePopup(session);
  }

  clearAll(session: TerminalSession) {
    session.highlights.forEach(h => this.disposeHighlight(h));
    session.highlights = [];
    this.hidePopup(session);
  }

  hidePopup(session: TerminalSession) {
    this.cancelHidePopup(session);
    if (session.highlightPopup) {
      session.highlightPopup.remove();
      session.highlightPopup = null;
    }
    session.activeHighlightId = null;
  }

  // ---- Private ----

  /** Release the xterm decorations and markers backing a highlight. */
  private disposeHighlight(h: TerminalHighlight) {
    h.decorations.forEach(d => d.dispose());
    h.markers.forEach(m => m.dispose());
  }

  private render(session: TerminalSession, highlight: TerminalHighlight) {
    const buffer = session.terminal.buffer.active;
    // The decoration overlays the text canvas, so the color must stay
    // semi-transparent or it would hide the text underneath.
    const backgroundColor =
      hexToRgba(this.getSettings().highlightColor, HIGHLIGHT_ALPHA) ?? FALLBACK_HIGHLIGHT_COLOR;

    for (let line = highlight.startLine; line <= highlight.endLine; line++) {
      const lineOffset = line - (buffer.baseY + buffer.cursorY);
      const marker = session.terminal.registerMarker(lineOffset);
      if (!marker) continue;

      highlight.markers.push(marker);

      let startX = 0;
      let width = session.terminal.cols;

      if (line === highlight.startLine) {
        startX = highlight.startCol;
        width = line === highlight.endLine
          ? highlight.endCol - highlight.startCol
          : session.terminal.cols - highlight.startCol;
      } else if (line === highlight.endLine) {
        startX = 0;
        width = highlight.endCol;
      }

      const decoration = session.terminal.registerDecoration({
        marker,
        x: startX,
        width,
        layer: "top",
      });

      if (decoration) {
        highlight.decorations.push(decoration);

        decoration.onRender((element) => {
          element.dataset.highlightId = highlight.id;
          element.addClass("claude-terminal-highlight");
          element.style.backgroundColor = backgroundColor;

          // xterm may reuse or recreate the DOM node on re-render; the flag
          // lives on the element so listeners are attached exactly once per node.
          if (element.dataset.hlListenersAdded) return;
          element.dataset.hlListenersAdded = "1";
          element.addEventListener("mouseenter", () => {
            this.cancelHidePopup(session);
            this.showPopup(session, highlight, element);
          });
          element.addEventListener("mouseleave", () => {
            this.scheduleHidePopup(session);
          });
        });
      }
    }
  }

  private showPopup(session: TerminalSession, highlight: TerminalHighlight, element: HTMLElement) {
    this.hidePopup(session);
    session.activeHighlightId = highlight.id;

    const popup = document.createElement("div");
    popup.addClass("claude-terminal-highlight-popup");

    const deleteBtn = popup.createEl("button", { cls: "claude-terminal-highlight-btn" });
    setIcon(deleteBtn, "x");
    deleteBtn.title = "Remove highlight";
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.remove(session, highlight.id);
    });

    const copyBtn = popup.createEl("button", { cls: "claude-terminal-highlight-btn" });
    setIcon(copyBtn, "copy");
    copyBtn.title = "Copy to clipboard";
    copyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void navigator.clipboard.writeText(highlight.text);
      new Notice("Copied to clipboard");
    });

    // Anchor the popup to the last decoration element (end of the highlight)
    const lastDecEl = this.findLastHighlightElement(session, highlight);
    const anchorEl = lastDecEl || element;

    const rect = anchorEl.getBoundingClientRect();
    popup.style.position = "fixed";
    popup.style.top = `${rect.top + (rect.height - 22) / 2}px`;
    popup.style.left = `${rect.right + 4}px`;
    popup.style.zIndex = "10000";

    popup.addEventListener("mouseenter", () => this.cancelHidePopup(session));
    popup.addEventListener("mouseleave", () => this.scheduleHidePopup(session));

    document.body.appendChild(popup);
    session.highlightPopup = popup;
  }

  private findLastHighlightElement(session: TerminalSession, highlight: TerminalHighlight): HTMLElement | null {
    const container = session.terminal.element;
    if (!container) return null;
    const els = container.querySelectorAll<HTMLElement>(`[data-highlight-id="${highlight.id}"]`);
    if (els.length === 0) return null;
    // Return the element with the largest bounding top (last line)
    let last = els[0];
    for (let i = 1; i < els.length; i++) {
      if (els[i].getBoundingClientRect().top > last.getBoundingClientRect().top) {
        last = els[i];
      }
    }
    return last;
  }

  private scheduleHidePopup(session: TerminalSession) {
    this.cancelHidePopup(session);
    session.hidePopupTimeout = setTimeout(() => {
      this.hidePopup(session);
    }, 300);
  }

  private cancelHidePopup(session: TerminalSession) {
    if (session.hidePopupTimeout) {
      clearTimeout(session.hidePopupTimeout);
      session.hidePopupTimeout = null;
    }
  }
}

/**
 * Write highlights to a markdown file in the vault, appending a new
 * section if today's file already exists.
 */
export async function saveHighlightsToVault(
  vaultPath: string,
  settings: ClaudeTerminalSettings,
  highlights: TerminalHighlight[],
): Promise<void> {
  if (highlights.length === 0) {
    new Notice("No highlights to save");
    return;
  }

  const sorted = [...highlights].sort((a, b) => a.timestamp - b.timestamp);

  const now = new Date();
  const dateStr = now.toISOString().split("T")[0];
  const timeStr = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

  let content = `---
type: highlights
tags: claude-code, terminal
last_edited: ${dateStr}
summary: Highlights from Claude Code terminal session
---

# Claude Terminal Highlights - ${dateStr} ${timeStr}

`;

  sorted.forEach(h => {
    const escapedText = h.text.replace(/\n/g, " ").trim();
    content += `- ${escapedText}\n`;
  });

  const folderPath = settings.highlightSavePath;
  const fileName = `Claude Terminal - ${dateStr}.md`;

  try {
    const fullFolderPath = path.join(vaultPath, folderPath);
    if (!fs.existsSync(fullFolderPath)) {
      fs.mkdirSync(fullFolderPath, { recursive: true });
    }

    const fullFilePath = path.join(fullFolderPath, fileName);
    if (fs.existsSync(fullFilePath)) {
      const newHighlightsSection = content.split("# Claude Terminal Highlights")[1];
      if (newHighlightsSection) {
        fs.appendFileSync(fullFilePath, `\n---\n\n# Session ${timeStr}\n${newHighlightsSection}`);
      }
    } else {
      fs.writeFileSync(fullFilePath, content);
    }

    new Notice(`Saved ${sorted.length} highlights to ${fileName}`);
  } catch (error) {
    console.error("Failed to save highlights:", error);
    new Notice("Failed to save highlights");
  }
}
