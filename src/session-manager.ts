import { FileSystemAdapter, Notice, setIcon } from "obsidian";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import * as path from "path";
import type {
  PersistedSession,
  SessionHistoryEntry,
  TerminalHighlight,
  TerminalSession,
} from "./types";
import { HighlightController } from "./highlights";
import { watchForClaudeSessionId } from "./claude-session";
import { cleanCopyText, normalizeCssColor } from "./text-utils";
import type ClaudeTerminalPlugin from "./main";

type NodePtyModule = typeof import("node-pty");

const electronRequire = (window as unknown as { require: NodeJS.Require }).require;

/**
 * Manages a set of terminal sessions sharing one tab bar: lifecycle,
 * PTY wiring, tab rendering, and persistence.
 */
export class TerminalSessionManager {
  private sessions: Map<string, TerminalSession> = new Map();
  private activeSessionId: string | null = null;
  private sessionCounter = 0;
  private plugin: ClaudeTerminalPlugin;
  private tabBar: HTMLElement;
  private sessionsContainer: HTMLElement;
  private highlighter: HighlightController;
  private clickTimer: NodeJS.Timeout | null = null;
  private clickedTabId: string | null = null;
  private nodePtyModule: NodePtyModule | null = null;
  private persist: boolean;
  private isRestoring = false;
  private draggedSessionId: string | null = null;
  private activeHistoryDropdown: HTMLElement | null = null;
  private historyCloseHandler: ((e: MouseEvent) => void) | null = null;

  constructor(plugin: ClaudeTerminalPlugin, tabBar: HTMLElement, sessionsContainer: HTMLElement, persist = false) {
    this.plugin = plugin;
    this.tabBar = tabBar;
    this.sessionsContainer = sessionsContainer;
    this.persist = persist;
    this.highlighter = new HighlightController(() => this.plugin.settings);

    // Pre-cache node-pty module
    try {
      const pluginPath = this.plugin.getPluginPath();
      const nodePtyPath = path.join(pluginPath, "node_modules", "node-pty");
      try {
        this.nodePtyModule = electronRequire(nodePtyPath) as NodePtyModule;
      } catch {
        this.nodePtyModule = electronRequire("node-pty") as NodePtyModule;
      }
    } catch { /* will fail later in startPty */ }
  }

  // ---- Session lifecycle ----

  createSession(name?: string, resume = false, isRestored = false, claudeSessionId?: string) {
    this.sessionCounter++;
    const id = `session-${Date.now()}-${this.sessionCounter}`;
    const sessionName = name || `Session ${this.sessions.size + 1}`;

    this.plugin.addSessionToHistory(sessionName, claudeSessionId || undefined);

    const container = this.sessionsContainer.createDiv({ cls: "claude-terminal-session" });
    const content = container.createDiv({ cls: "claude-terminal-session-content" });

    const theme = this.getObsidianTheme();
    const terminal = new Terminal({
      fontSize: this.plugin.settings.fontSize,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: theme.background,
        foreground: theme.foreground,
        cursor: theme.cursor,
        selectionBackground: theme.selectionBackground,
      },
      cursorBlink: true,
      cursorStyle: "bar",
      allowTransparency: true,
      allowProposedApi: true,
      scrollback: 10000,
      cols: 80,
      rows: 24,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(content);

    const session: TerminalSession = {
      id,
      name: sessionName,
      claudeSessionId: claudeSessionId || null,
      terminal,
      fitAddon,
      ptyProcess: null,
      container,
      highlights: [],
      highlightPopup: null,
      activeHighlightId: null,
      hidePopupTimeout: null,
      resizeObserver: null,
      fitDebounceTimer: null,
      isRestored,
    };

    // Custom key event handler: Shift+Enter, and clean-copy on Cmd/Ctrl+C
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.shiftKey && event.key === "Enter") {
        if (event.type === "keydown") {
          session.ptyProcess?.write("\x1b[13;2u");
        }
        event.preventDefault();
        event.stopPropagation();
        return false;
      }

      // Clean-copy on Cmd/Ctrl+C when there's a selection
      if (
        event.type === "keydown" &&
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        (event.key === "c" || event.key === "C")
      ) {
        let sel = terminal.getSelection();
        if (sel && sel.length > 0) {
          // Always strip quote formatting (▎) regardless of cleanCopy setting
          sel = sel.replace(/^▎ ?/gm, "");
          const cleaned = this.plugin.settings.cleanCopy ? cleanCopyText(sel) : sel;
          void navigator.clipboard.writeText(cleaned);
          event.preventDefault();
          event.stopPropagation();
          return false;
        }
      }

      return true;
    });

    // Auto-highlight on selection (gated by setting)
    terminal.element?.addEventListener("mouseup", () => {
      if (!this.plugin.settings.highlightingEnabled) return;
      setTimeout(() => {
        const selection = terminal.getSelection();
        if (selection && selection.trim().length > 0) {
          this.highlighter.createFromSelection(session);
        }
      }, 100);
    });

    this.sessions.set(id, session);

    // Set active state directly (avoid switchToSession's extra rAF + renderTabBar)
    this.sessions.forEach(s => { s.container.style.display = "none"; });
    session.container.style.display = "flex";
    this.activeSessionId = id;

    // Single rAF: fit, start PTY, focus, render tabs
    requestAnimationFrame(() => {
      fitAddon.fit();
      this.startPty(session, resume);
      terminal.focus();
      this.renderTabBar();
    });

    // Resize observer on the content div
    session.resizeObserver = new ResizeObserver(() => {
      if (session.fitDebounceTimer) clearTimeout(session.fitDebounceTimer);
      session.fitDebounceTimer = setTimeout(() => {
        if (session.fitAddon && session.terminal && session.ptyProcess && this.activeSessionId === session.id) {
          session.fitAddon.fit();
        }
      }, 50);
    });
    session.resizeObserver.observe(content);

    this.persistSessions();
  }

  switchToSession(id: string) {
    const session = this.sessions.get(id);
    if (!session) return;

    this.sessions.forEach(s => {
      s.container.style.display = "none";
    });

    session.container.style.display = "flex";
    this.activeSessionId = id;

    // Double rAF: first ensures display:flex is applied, second ensures layout is computed
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        session.fitAddon.fit();
        session.terminal.scrollToBottom();
        session.terminal.focus();
      });
    });

    this.renderTabBar();
  }

  closeSession(id: string) {
    const session = this.sessions.get(id);
    if (!session) return;

    this.destroySession(session);
    this.sessions.delete(id);

    if (this.activeSessionId === id) {
      this.activeSessionId = null;
      const remaining = Array.from(this.sessions.keys());
      if (remaining.length > 0) {
        this.switchToSession(remaining[remaining.length - 1]);
      } else {
        this.createSession();
        return;
      }
    }

    this.renderTabBar();
    this.persistSessions();
  }

  renameSession(id: string, newName: string) {
    const session = this.sessions.get(id);
    if (!session) return;
    const trimmed = newName.trim();
    if (trimmed.length === 0) return;
    session.name = trimmed;
    this.plugin.addSessionToHistory(trimmed, session.claudeSessionId || undefined);
    this.renderTabBar();
    this.persistSessions();
  }

  reorderSession(fromId: string, toId: string, before: boolean) {
    if (fromId === toId) return;
    const order = Array.from(this.sessions.keys());
    const fromIdx = order.indexOf(fromId);
    if (fromIdx === -1) return;
    const [moved] = order.splice(fromIdx, 1);
    let toIdx = order.indexOf(toId);
    if (toIdx === -1) return;
    if (!before) toIdx += 1;
    order.splice(toIdx, 0, moved);

    const newMap = new Map<string, TerminalSession>();
    for (const sid of order) {
      newMap.set(sid, this.sessions.get(sid)!);
    }
    this.sessions = newMap;
    this.renderTabBar();
    this.persistSessions();
  }

  persistSessions() {
    if (!this.persist || this.isRestoring) return;
    const list: PersistedSession[] = [];
    this.sessions.forEach(s => {
      list.push({ name: s.name, claudeSessionId: s.claudeSessionId || undefined });
    });
    this.plugin.settings.persistedSessions = list;
    void this.plugin.saveSettings();
  }

  restoreSessions(): boolean {
    const persisted = this.plugin.settings.persistedSessions;
    if (!persisted || persisted.length === 0) return false;
    this.isRestoring = true;
    try {
      for (const entry of persisted) {
        this.createSession(entry.name, true, true, entry.claudeSessionId);
      }
    } finally {
      this.isRestoring = false;
    }
    return true;
  }

  getActiveSession(): TerminalSession | undefined {
    if (!this.activeSessionId) return undefined;
    return this.sessions.get(this.activeSessionId);
  }

  sendClear() {
    this.getActiveSession()?.ptyProcess?.write("clear\r");
  }

  getAllHighlights(): TerminalHighlight[] {
    const all: TerminalHighlight[] = [];
    this.sessions.forEach(s => all.push(...s.highlights));
    return all;
  }

  clearAllHighlights() {
    this.sessions.forEach(s => this.highlighter.clearAll(s));
  }

  destroyAll() {
    this.closeHistoryMenu();
    this.sessions.forEach(s => this.destroySession(s));
    this.sessions.clear();
    this.activeSessionId = null;
    this.sessionCounter = 0;
    this.tabBar.empty();
  }

  hasActiveSessions(): boolean {
    return this.sessions.size > 0;
  }

  refitActive() {
    const session = this.getActiveSession();
    if (session) {
      session.fitAddon.fit();
      session.terminal.scrollToBottom();
      session.terminal.focus();
    }
  }

  refreshTheme() {
    const theme = this.getObsidianTheme();
    this.sessions.forEach(session => {
      session.terminal.options.theme = theme;
    });
  }

  // ---- Private helpers ----

  private destroySession(session: TerminalSession) {
    session.resizeObserver?.disconnect();
    if (session.fitDebounceTimer) clearTimeout(session.fitDebounceTimer);
    if (session.ptyProcess) {
      session.ptyProcess.kill();
    }
    session.terminal.dispose();
    this.highlighter.hidePopup(session);
    session.container.remove();
  }

  private getObsidianTheme() {
    const styles = getComputedStyle(document.body);
    const isDark = document.body.classList.contains("theme-dark");
    const cssVar = (name: string) => normalizeCssColor(styles.getPropertyValue(name).trim());
    return {
      background: cssVar("--background-primary") ?? (isDark ? "#1e1e1e" : "#ffffff"),
      foreground: cssVar("--text-normal") ?? (isDark ? "#d4d4d4" : "#1f1f1f"),
      cursor: cssVar("--text-accent") ?? "#528bff",
      selectionBackground: cssVar("--text-selection")
        ?? (isDark ? "rgba(70, 118, 180, 0.45)" : "rgba(140, 180, 255, 0.4)"),
    };
  }

  private startPty(session: TerminalSession, resume = false) {
    if (!session.terminal) return;

    try {
      if (!this.nodePtyModule) {
        throw new Error("node-pty module not loaded");
      }

      const vaultPath = (this.plugin.app.vault.adapter as FileSystemAdapter).getBasePath();

      session.ptyProcess = this.nodePtyModule.spawn(this.plugin.settings.shellPath, [], {
        name: "xterm-256color",
        cols: session.terminal.cols,
        rows: session.terminal.rows,
        cwd: vaultPath,
        env: {
          ...process.env,
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
        },
      });

      session.ptyProcess!.onData((data: string) => {
        session.terminal?.write(data);
      });

      session.terminal.onData((data: string) => {
        session.ptyProcess?.write(data);
      });

      session.terminal.onResize(({ cols, rows }: { cols: number; rows: number }) => {
        session.ptyProcess?.resize(cols, rows);
      });

      if (this.plugin.settings.autoLaunchClaude) {
        let cmd: string;
        if (resume && session.claudeSessionId) {
          cmd = `clear && claude --resume ${session.claudeSessionId}`;
        } else if (resume || this.sessionCounter === 1) {
          cmd = "clear && claude --continue";
        } else {
          cmd = "clear && claude";
        }
        setTimeout(() => {
          session.ptyProcess?.write(cmd + "\r");
        }, 300);
        setTimeout(() => {
          session.terminal?.scrollToBottom();
        }, 1500);

        this.detectClaudeSessionId(session);
      }
    } catch (error) {
      console.error("Claude Terminal: Failed to start PTY", error);
      session.terminal?.write("\r\n\x1b[31mError: Failed to start terminal.\x1b[0m\r\n");
      session.terminal?.write(`\r\n${error}\r\n`);
    }
  }

  private detectClaudeSessionId(session: TerminalSession) {
    // If we already have a session ID (resuming from history), no need to detect
    if (session.claudeSessionId) return;

    const shellPid = session.ptyProcess?.pid;
    if (!shellPid) return;

    const vaultPath = (this.plugin.app.vault.adapter as FileSystemAdapter).getBasePath();

    watchForClaudeSessionId({
      shellPid,
      vaultPath,
      isSettled: () => session.claudeSessionId !== null,
      onDetected: (sessionId) => {
        session.claudeSessionId = sessionId;
        this.plugin.updateSessionHistoryId(session.name, sessionId);
        this.persistSessions();
      },
    });
  }

  // ---- Tab bar ----

  renderTabBar() {
    // Preserve scroll position across re-renders
    const prevScroll = this.tabBar.querySelector(".claude-terminal-tabs-scroll");
    const savedScrollLeft = prevScroll ? prevScroll.scrollLeft : 0;

    this.tabBar.empty();

    const tabsScroll = this.tabBar.createDiv({ cls: "claude-terminal-tabs-scroll" });

    this.sessions.forEach((session) => {
      const tab = tabsScroll.createDiv({
        cls: `claude-terminal-tab ${session.id === this.activeSessionId ? "is-active" : ""}${session.isRestored ? " is-restored" : ""}`,
      });
      tab.draggable = true;

      // Drag-and-drop reordering
      tab.addEventListener("dragstart", (e) => {
        this.draggedSessionId = session.id;
        tab.addClass("is-dragging");
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", session.id);
        }
      });
      tab.addEventListener("dragend", () => {
        this.draggedSessionId = null;
        tab.removeClass("is-dragging");
        tabsScroll.querySelectorAll(".claude-terminal-tab").forEach(t => {
          t.removeClass("drop-before");
          t.removeClass("drop-after");
        });
      });
      tab.addEventListener("dragover", (e) => {
        if (!this.draggedSessionId || this.draggedSessionId === session.id) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        const rect = tab.getBoundingClientRect();
        const before = (e.clientX - rect.left) < rect.width / 2;
        tab.toggleClass("drop-before", before);
        tab.toggleClass("drop-after", !before);
      });
      tab.addEventListener("dragleave", () => {
        tab.removeClass("drop-before");
        tab.removeClass("drop-after");
      });
      tab.addEventListener("drop", (e) => {
        e.preventDefault();
        const fromId = this.draggedSessionId;
        if (!fromId || fromId === session.id) return;
        const rect = tab.getBoundingClientRect();
        const before = (e.clientX - rect.left) < rect.width / 2;
        this.reorderSession(fromId, session.id, before);
      });

      const nameSpan = tab.createSpan({ cls: "claude-terminal-tab-name", text: session.name });

      // Click timer: single click = switch, double click = rename
      nameSpan.addEventListener("click", (e) => {
        e.stopPropagation();
        if (this.clickedTabId === session.id && this.clickTimer) {
          // Double click
          clearTimeout(this.clickTimer);
          this.clickTimer = null;
          this.clickedTabId = null;
          this.startRenameTab(session.id, nameSpan);
        } else {
          // First click — wait for possible double
          if (this.clickTimer) clearTimeout(this.clickTimer);
          this.clickedTabId = session.id;
          this.clickTimer = setTimeout(() => {
            this.clickTimer = null;
            this.clickedTabId = null;
            this.switchToSession(session.id);
          }, 250);
        }
      });

      // Click on tab background (not name) switches immediately
      tab.addEventListener("click", (e) => {
        if (!(e.target as HTMLElement).closest(".claude-terminal-tab-close") &&
            !(e.target as HTMLElement).closest(".claude-terminal-tab-name")) {
          this.switchToSession(session.id);
        }
      });

      // Close button (only if more than 1 session)
      if (this.sessions.size > 1) {
        const closeBtn = tab.createSpan({ cls: "claude-terminal-tab-close" });
        setIcon(closeBtn, "x");
        closeBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          this.closeSession(session.id);
        });
      }
    });

    // Action buttons wrapper (stays visible even when tabs overflow)
    const actionsWrapper = this.tabBar.createDiv({ cls: "claude-terminal-tab-actions" });

    // Highlighter toggle button
    const highlightOn = this.plugin.settings.highlightingEnabled;
    const highlightBtn = actionsWrapper.createDiv({
      cls: `claude-terminal-tab-action claude-terminal-highlight-toggle ${highlightOn ? "is-active" : "is-disabled"}`,
      attr: { "aria-label": highlightOn ? "Highlighting: on" : "Highlighting: off" },
    });
    setIcon(highlightBtn, "highlighter");
    highlightBtn.title = highlightOn ? "Highlighting: on (click to disable)" : "Highlighting: off (click to enable)";
    highlightBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      this.plugin.settings.highlightingEnabled = !this.plugin.settings.highlightingEnabled;
      await this.plugin.saveSettings();
      this.renderTabBar();
    });

    // New tab button
    const newBtn = actionsWrapper.createDiv({ cls: "claude-terminal-tab-action", attr: { "aria-label": "New session" } });
    setIcon(newBtn, "plus");
    newBtn.title = "New session";
    newBtn.addEventListener("click", () => this.createSession());

    // History button
    if (this.plugin.settings.sessionHistory.length > 0) {
      const historyBtn = actionsWrapper.createDiv({ cls: "claude-terminal-tab-action", attr: { "aria-label": "Recent sessions" } });
      setIcon(historyBtn, "clock");
      historyBtn.title = "Open recent session";
      historyBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.showHistoryMenu(historyBtn);
      });
    }

    // Restore scroll position
    if (savedScrollLeft > 0) {
      tabsScroll.scrollLeft = savedScrollLeft;
    }
  }

  private startRenameTab(sessionId: string, nameSpan: HTMLElement) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const input = document.createElement("input");
    input.type = "text";
    input.value = session.name;
    input.className = "claude-terminal-tab-rename";

    const commit = () => {
      this.renameSession(sessionId, input.value);
    };

    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur();
      } else if (e.key === "Escape") {
        input.value = session.name;
        input.blur();
      }
    });

    nameSpan.replaceWith(input);
    input.focus();
    input.select();
  }

  private showHistoryMenu(anchor: HTMLElement) {
    // Close any existing history dropdown
    this.closeHistoryMenu();

    const history = this.plugin.settings.sessionHistory;
    const seen = new Set<string>();
    const entries: SessionHistoryEntry[] = [];
    for (let i = history.length - 1; i >= 0; i--) {
      const entry = history[i];
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      entries.push(entry);
      if (seen.size >= 15) break;
    }

    if (entries.length === 0) {
      new Notice("No session history yet");
      return;
    }

    const dropdown = document.createElement("div");
    dropdown.className = "claude-terminal-history-dropdown";
    const rect = anchor.getBoundingClientRect();
    dropdown.style.position = "fixed";
    dropdown.style.right = `${window.innerWidth - rect.right}px`;
    dropdown.style.top = `${rect.bottom + 4}px`;
    dropdown.style.zIndex = "10000";

    for (const entry of entries) {
      const row = dropdown.createDiv({ cls: "claude-terminal-history-item" });

      const nameEl = row.createSpan({ cls: "claude-terminal-history-name", text: entry.name });
      nameEl.addEventListener("click", () => {
        this.closeHistoryMenu();
        this.createSession(entry.name, true);
      });

      const delBtn = row.createSpan({ cls: "claude-terminal-history-delete" });
      setIcon(delBtn, "x");
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.plugin.settings.sessionHistory = this.plugin.settings.sessionHistory
          .filter((h) => h.name !== entry.name);
        void this.plugin.saveSettings();
        row.remove();
        // Close if empty
        if (dropdown.childElementCount === 0) this.closeHistoryMenu();
      });
    }

    document.body.appendChild(dropdown);
    this.activeHistoryDropdown = dropdown;

    // Close on click outside
    const closeHandler = (e: MouseEvent) => {
      if (!dropdown.contains(e.target as Node) && e.target !== anchor) {
        this.closeHistoryMenu();
        document.removeEventListener("mousedown", closeHandler, true);
      }
    };
    document.addEventListener("mousedown", closeHandler, true);
    this.historyCloseHandler = closeHandler;
  }

  private closeHistoryMenu() {
    if (this.activeHistoryDropdown) {
      this.activeHistoryDropdown.remove();
      this.activeHistoryDropdown = null;
    }
    if (this.historyCloseHandler) {
      document.removeEventListener("mousedown", this.historyCloseHandler, true);
      this.historyCloseHandler = null;
    }
  }
}
