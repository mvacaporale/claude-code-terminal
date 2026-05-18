import { App, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, ItemView, Menu, FileSystemAdapter, setIcon, Notice } from "obsidian";
import { Terminal, IDecoration, IMarker } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { IPty } from "node-pty";
import * as path from "path";
import * as fs from "fs";
import { execSync } from "child_process";

// ========== Types ==========

interface TerminalHighlight {
  id: string;
  text: string;
  timestamp: number;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  decorations: IDecoration[];
  markers: IMarker[];
}

interface TerminalSession {
  id: string;
  name: string;
  claudeSessionId: string | null;
  terminal: Terminal;
  fitAddon: FitAddon;
  ptyProcess: IPty | null;
  container: HTMLElement;
  highlights: TerminalHighlight[];
  highlightPopup: HTMLElement | null;
  activeHighlightId: string | null;
  hidePopupTimeout: NodeJS.Timeout | null;
  resizeObserver: ResizeObserver | null;
  fitDebounceTimer: NodeJS.Timeout | null;
  isRestored: boolean;
}

interface SessionHistoryEntry {
  name: string;
  sessionId?: string;
}

interface PersistedSession {
  name: string;
  claudeSessionId?: string;
}

const electronRequire = (window as unknown as { require: NodeJS.Require }).require;

const VIEW_TYPE_CLAUDE_TERMINAL = "claude-terminal-view";

interface ClaudeTerminalSettings {
  shellPath: string;
  autoLaunchClaude: boolean;
  fontSize: number;
  floatingWidth: number;
  floatingHeight: number;
  highlightColor: string;
  highlightSavePath: string;
  centeredView: boolean;
  sessionHistory: SessionHistoryEntry[];
  highlightingEnabled: boolean;
  restoreSessionsOnStartup: boolean;
  cleanCopy: boolean;
  persistedSessions: PersistedSession[];
}

const DEFAULT_SETTINGS: ClaudeTerminalSettings = {
  shellPath: process.platform === "win32" ? "powershell.exe" : process.env.SHELL || "/bin/zsh",
  autoLaunchClaude: true,
  fontSize: 13,
  floatingWidth: 500,
  floatingHeight: 350,
  highlightColor: "#fef3c7",
  highlightSavePath: "3. Resources/Highlights",
  centeredView: false,
  sessionHistory: [],
  highlightingEnabled: true,
  restoreSessionsOnStartup: true,
  cleanCopy: true,
  persistedSessions: [],
};

// ========== TerminalSessionManager ==========

class TerminalSessionManager {
  private sessions: Map<string, TerminalSession> = new Map();
  private activeSessionId: string | null = null;
  private sessionCounter = 0;
  private plugin: ClaudeTerminalPlugin;
  private tabBar: HTMLElement;
  private sessionsContainer: HTMLElement;
  private clickTimer: NodeJS.Timeout | null = null;
  private clickedTabId: string | null = null;
  private nodePtyModule: any = null;
  private persist: boolean;
  private isRestoring: boolean = false;
  private draggedSessionId: string | null = null;

  constructor(plugin: ClaudeTerminalPlugin, tabBar: HTMLElement, sessionsContainer: HTMLElement, persist: boolean = false) {
    this.plugin = plugin;
    this.tabBar = tabBar;
    this.sessionsContainer = sessionsContainer;
    this.persist = persist;

    // Pre-cache node-pty module
    try {
      const pluginPath = this.plugin.getPluginPath();
      const nodePtyPath = path.join(pluginPath, "node_modules", "node-pty");
      try {
        this.nodePtyModule = electronRequire(nodePtyPath);
      } catch {
        this.nodePtyModule = electronRequire("node-pty");
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
          const cleaned = this.plugin.settings.cleanCopy ? this.cleanCopyText(sel) : sel;
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
          this.createHighlightFromSelection(session);
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

  private cleanCopyText(text: string): string {
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
    this.sessions.forEach(s => this.clearSessionHighlights(s));
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

  // ---- Private helpers ----

  private destroySession(session: TerminalSession) {
    session.resizeObserver?.disconnect();
    if (session.fitDebounceTimer) clearTimeout(session.fitDebounceTimer);
    if (session.ptyProcess) {
      session.ptyProcess.kill();
    }
    session.terminal.dispose();
    this.hideSessionPopup(session);
    session.container.remove();
  }

  refreshTheme() {
    const theme = this.getObsidianTheme();
    this.sessions.forEach(session => {
      session.terminal.options.theme = theme;
    });
  }

  private getObsidianTheme() {
    const styles = getComputedStyle(document.body);
    return {
      background: styles.getPropertyValue("--background-primary").trim() || "#1e1e1e",
      foreground: styles.getPropertyValue("--text-normal").trim() || "#d4d4d4",
      cursor: styles.getPropertyValue("--text-accent").trim() || "#528bff",
      selectionBackground: styles.getPropertyValue("--text-selection").trim() || "#264f78",
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

        // Detect Claude session ID after launch
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

    const sessionsDir = path.join(process.env.HOME || "", ".claude", "sessions");
    const launchTime = Date.now();
    const vaultPath = (this.plugin.app.vault.adapter as FileSystemAdapter).getBasePath();

    const tryPidBased = (): string | null => {
      try {
        // Find child PIDs of the shell process
        const output = execSync(`pgrep -P ${shellPid}`, { encoding: "utf-8", timeout: 2000 }).trim();
        const childPids = output.split("\n").filter(p => p.length > 0);
        for (const pid of childPids) {
          const sessionFile = path.join(sessionsDir, `${pid}.json`);
          if (fs.existsSync(sessionFile)) {
            try {
              const data = JSON.parse(fs.readFileSync(sessionFile, "utf-8"));
              if (data.sessionId) return data.sessionId;
            } catch { /* ignore parse errors */ }
          }
        }
      } catch { /* pgrep returns non-zero if no children found */ }
      return null;
    };

    const tryFallback = (): string | null => {
      // Scan sessions dir for files created after our launch time with matching cwd
      if (!fs.existsSync(sessionsDir)) return null;
      try {
        const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith(".json"));
        const candidates: { sessionId: string; startedAt: number }[] = [];
        for (const f of files) {
          try {
            const data = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), "utf-8"));
            if (data.sessionId && data.startedAt > launchTime && data.cwd?.startsWith(vaultPath)) {
              candidates.push({ sessionId: data.sessionId, startedAt: data.startedAt });
            }
          } catch { /* ignore */ }
        }
        if (candidates.length > 0) {
          candidates.sort((a, b) => b.startedAt - a.startedAt);
          return candidates[0].sessionId;
        }
      } catch { /* ignore */ }
      return null;
    };

    const attempt = (n: number) => {
      if (n > 5 || session.claudeSessionId) return;
      setTimeout(() => {
        if (session.claudeSessionId) return; // detected by a previous attempt completing late

        // Try PID-based detection first, then fallback
        const sessionId = tryPidBased() || tryFallback();
        if (sessionId) {
          session.claudeSessionId = sessionId;
          this.plugin.updateSessionHistoryId(session.name, sessionId);
          this.persistSessions();
          return;
        }

        attempt(n + 1);
      }, 2000 + n * 2000);
    };

    attempt(0);
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
        this.plugin.saveData(this.plugin.settings);
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

  private activeHistoryDropdown: HTMLElement | null = null;
  private historyCloseHandler: ((e: MouseEvent) => void) | null = null;

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

  // ---- Highlights ----

  private createHighlightFromSelection(session: TerminalSession) {
    const selection = session.terminal.getSelection();
    if (!selection || selection.trim().length === 0) return;

    const selectionPosition = session.terminal.getSelectionPosition();
    if (!selectionPosition) return;

    // selectionPosition uses 1-based coordinates; convert to 0-based
    let startLine = selectionPosition.start.y - 1;
    let startCol = selectionPosition.start.x - 1;
    let endLine = selectionPosition.end.y - 1;
    let endCol = selectionPosition.end.x - 1;

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
      h.decorations.forEach(d => d.dispose());
      h.markers.forEach(m => m.dispose());
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
      id: `hl-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      text: lines.join("\n"),
      timestamp: Date.now(),
      startLine,
      startCol,
      endLine,
      endCol,
      decorations: [],
      markers: [],
    };

    this.renderHighlight(session, highlight);
    session.highlights.push(highlight);
    session.terminal.clearSelection();
  }

  private renderHighlight(session: TerminalSession, highlight: TerminalHighlight) {
    const buffer = session.terminal.buffer.active;
    const highlightColor = this.plugin.settings.highlightColor;

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

      const isDark = document.body.classList.contains("theme-dark");
      const decoration = session.terminal.registerDecoration({
        marker,
        x: startX,
        width,
        layer: "top",
      });

      if (decoration) {
        highlight.decorations.push(decoration);

        let listenersAdded = false;
        decoration.onRender((element) => {
          element.dataset.highlightId = highlight.id;
          element.addClass("claude-terminal-highlight");

          if (!listenersAdded) {
            listenersAdded = true;
            element.addEventListener("mouseenter", () => {
              this.cancelSessionHidePopup(session);
              this.showSessionHighlightPopup(session, highlight, element);
            });
            element.addEventListener("mouseleave", () => {
              this.scheduleSessionHidePopup(session);
            });
          }
        });
      }
    }
  }

  private showSessionHighlightPopup(session: TerminalSession, highlight: TerminalHighlight, element: HTMLElement) {
    this.hideSessionPopup(session);
    session.activeHighlightId = highlight.id;

    const popup = document.createElement("div");
    popup.addClass("claude-terminal-highlight-popup");

    const deleteBtn = popup.createEl("button", { cls: "claude-terminal-highlight-btn" });
    setIcon(deleteBtn, "x");
    deleteBtn.title = "Remove highlight";
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.removeSessionHighlight(session, highlight.id);
    });

    const copyBtn = popup.createEl("button", { cls: "claude-terminal-highlight-btn" });
    setIcon(copyBtn, "copy");
    copyBtn.title = "Copy to clipboard";
    copyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(highlight.text);
      new Notice("Copied to clipboard");
    });

    // Find the last decoration element for this highlight (end of text)
    const lastDecEl = this.findLastHighlightElement(session, highlight);
    const anchorEl = lastDecEl || element;

    const rect = anchorEl.getBoundingClientRect();
    popup.style.position = "fixed";
    popup.style.top = `${rect.top + (rect.height - 22) / 2}px`;
    popup.style.left = `${rect.right + 4}px`;
    popup.style.zIndex = "10000";

    popup.addEventListener("mouseenter", () => this.cancelSessionHidePopup(session));
    popup.addEventListener("mouseleave", () => this.scheduleSessionHidePopup(session));

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

  private scheduleSessionHidePopup(session: TerminalSession) {
    this.cancelSessionHidePopup(session);
    session.hidePopupTimeout = setTimeout(() => {
      this.hideSessionPopup(session);
    }, 300);
  }

  private cancelSessionHidePopup(session: TerminalSession) {
    if (session.hidePopupTimeout) {
      clearTimeout(session.hidePopupTimeout);
      session.hidePopupTimeout = null;
    }
  }

  private hideSessionPopup(session: TerminalSession) {
    this.cancelSessionHidePopup(session);
    if (session.highlightPopup) {
      session.highlightPopup.remove();
      session.highlightPopup = null;
    }
    session.activeHighlightId = null;
  }

  private removeSessionHighlight(session: TerminalSession, id: string) {
    const index = session.highlights.findIndex(h => h.id === id);
    if (index === -1) return;

    const highlight = session.highlights[index];
    highlight.decorations.forEach(d => d.dispose());
    highlight.markers.forEach(m => m.dispose());
    session.highlights.splice(index, 1);
    this.hideSessionPopup(session);
  }

  private clearSessionHighlights(session: TerminalSession) {
    session.highlights.forEach(h => {
      h.decorations.forEach(d => d.dispose());
      h.markers.forEach(m => m.dispose());
    });
    session.highlights = [];
    this.hideSessionPopup(session);
  }
}

// ========== Sidebar View ==========

class ClaudeTerminalView extends ItemView {
  private plugin: ClaudeTerminalPlugin;
  private manager: TerminalSessionManager | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: ClaudeTerminalPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_CLAUDE_TERMINAL;
  }

  getDisplayText(): string {
    return "Claude terminal";
  }

  getIcon(): string {
    return "terminal";
  }

  async onOpen(): Promise<void> {
    await super.onOpen();
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("claude-terminal-view-container");
    if (this.plugin.settings.centeredView) {
      container.addClass("is-centered");
    }

    const tabBar = container.createDiv({ cls: "claude-terminal-tab-bar" });
    const sessionsContainer = container.createDiv({ cls: "claude-terminal-sessions-container" });

    setTimeout(() => {
      this.manager = new TerminalSessionManager(this.plugin, tabBar, sessionsContainer, true);
      const restored = this.plugin.settings.restoreSessionsOnStartup
        ? this.manager.restoreSessions()
        : false;
      if (!restored) {
        this.manager.createSession();
      }
    }, 100);
  }

  private isInSidebar(): boolean {
    const leaf = this.leaf;
    return leaf?.getRoot() !== this.app.workspace.rootSplit;
  }

  onPaneMenu(menu: Menu) {
    if (this.isInSidebar()) {
      menu.addItem((item) => {
        item.setTitle("Move to main editor").setIcon("arrow-right")
          .onClick(() => { void this.plugin.openInCenter(); });
      });
    } else {
      menu.addItem((item) => {
        item.setTitle("Move to sidebar").setIcon("arrow-left")
          .onClick(() => { void this.plugin.openInSidebar(); });
      });
    }
    menu.addItem((item) => {
      item.setTitle("Undock to floating window").setIcon("arrow-up-right")
        .onClick(() => this.plugin.undockToFloating());
    });
    menu.addItem((item) => {
      item.setTitle("New terminal session").setIcon("plus")
        .onClick(() => this.manager?.createSession());
    });
    menu.addItem((item) => {
      item.setTitle("Clear terminal").setIcon("eraser")
        .onClick(() => this.manager?.sendClear());
    });
    menu.addItem((item) => {
      item.setTitle("Save highlights").setIcon("save")
        .onClick(() => this.plugin.saveHighlightsPublic());
    });
    menu.addItem((item) => {
      item.setTitle("Clear all highlights").setIcon("trash")
        .onClick(() => {
          this.manager?.clearAllHighlights();
          new Notice("Highlights cleared");
        });
    });
  }

  async onClose(): Promise<void> {
    await super.onClose();
    this.manager?.persistSessions();
    this.manager?.destroyAll();
  }

  // Public API for plugin
  createSession(name?: string) {
    this.manager?.createSession(name);
  }

  refreshTheme() {
    this.manager?.refreshTheme();
  }

  applyCenteredClass() {
    const container = this.containerEl.children[1] as HTMLElement | undefined;
    if (!container) return;
    container.classList.toggle("is-centered", this.plugin.settings.centeredView);
    requestAnimationFrame(() => this.manager?.refitActive());
  }

  getAllHighlights(): TerminalHighlight[] {
    return this.manager?.getAllHighlights() ?? [];
  }

  clearAllHighlights() {
    this.manager?.clearAllHighlights();
  }

  refreshTabBar() {
    this.manager?.renderTabBar();
  }
}

// ========== Main Plugin ==========

export default class ClaudeTerminalPlugin extends Plugin {
  settings: ClaudeTerminalSettings = DEFAULT_SETTINGS;

  // Floating terminal
  private floatingContainer: HTMLElement | null = null;
  private floatingManager: TerminalSessionManager | null = null;
  private isFloatingVisible: boolean = false;

  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_CLAUDE_TERMINAL, (leaf) => new ClaudeTerminalView(leaf, this));

    this.addRibbonIcon("terminal", "Toggle claude terminal", () => {
      this.toggleFloatingTerminal();
    });

    this.addCommand({
      id: "toggle-claude-terminal",
      name: "Toggle claude terminal (floating)",
      callback: () => this.toggleFloatingTerminal(),
    });

    this.addCommand({
      id: "open-claude-terminal-sidebar",
      name: "Open claude terminal in right sidebar",
      callback: () => { void this.openInSidebar(); },
    });

    this.addCommand({
      id: "open-claude-terminal-center",
      name: "Open claude terminal in main editor",
      callback: () => { void this.openInCenter(); },
    });

    this.addCommand({
      id: "new-terminal-session",
      name: "New terminal session",
      callback: () => {
        if (this.isFloatingVisible && this.floatingManager) {
          this.floatingManager.createSession();
        } else {
          const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDE_TERMINAL);
          if (leaves.length > 0) {
            (leaves[0].view as ClaudeTerminalView).createSession();
          }
        }
      },
    });

    this.addCommand({
      id: "save-terminal-highlights",
      name: "Save terminal highlights to file",
      callback: () => { void this.saveHighlights(); },
    });

    this.addCommand({
      id: "clear-terminal-highlights",
      name: "Clear all terminal highlights",
      callback: () => {
        this.clearAllHighlights();
        new Notice("All highlights cleared");
      },
    });

    // Toggle centered docked view
    this.addCommand({
      id: "toggle-claude-terminal-centered",
      name: "Toggle centered terminal view",
      callback: async () => {
        this.settings.centeredView = !this.settings.centeredView;
        await this.saveSettings();
        this.applyCenteredClassToAllViews();
      },
    });

    this.addSettingTab(new ClaudeTerminalSettingTab(this.app, this));

    // Refresh terminal theme when Obsidian's CSS changes (system dark/light flip, manual theme switch, snippet toggle)
    this.registerEvent(
      this.app.workspace.on("css-change", () => this.refreshAllTerminalThemes())
    );


    this.app.workspace.onLayoutReady(() => {
      this.createFloatingContainer();
    });
  }

  private refreshAllTerminalThemes() {
    this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDE_TERMINAL).forEach((leaf) => {
      const view = leaf.view;
      if (view instanceof ClaudeTerminalView) {
        view.refreshTheme();
      }
    });
    this.refreshFloatingTheme();
  }

  private refreshFloatingTheme() {
    this.floatingManager?.refreshTheme();
  }

  applyCenteredClassToAllViews() {
    this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDE_TERMINAL).forEach((leaf) => {
      const view = leaf.view;
      if (view instanceof ClaudeTerminalView) {
        view.applyCenteredClass();
      }
    });
  }

  onunload() {
    this.floatingManager?.destroyAll();
    if (this.floatingContainer) {
      this.floatingContainer.remove();
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    // Migrate old string[] format to SessionHistoryEntry[]
    if (this.settings.sessionHistory.length > 0 && typeof this.settings.sessionHistory[0] === "string") {
      this.settings.sessionHistory = (this.settings.sessionHistory as unknown as string[]).map(name => ({ name }));
      void this.saveSettings();
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  addSessionToHistory(name: string, sessionId?: string) {
    const history = this.settings.sessionHistory;
    const filtered = history.filter(e => e.name !== name);
    filtered.push({ name, sessionId });
    if (filtered.length > 30) {
      filtered.splice(0, filtered.length - 30);
    }
    this.settings.sessionHistory = filtered;
    void this.saveSettings();
  }

  refreshAllTabBars() {
    this.floatingManager?.renderTabBar();
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDE_TERMINAL);
    leaves.forEach(leaf => {
      (leaf.view as ClaudeTerminalView).refreshTabBar();
    });
  }

  updateSessionHistoryId(name: string, sessionId: string) {
    const entry = this.settings.sessionHistory.find(e => e.name === name);
    if (entry) {
      entry.sessionId = sessionId;
      void this.saveSettings();
    }
  }

  getClaudeProjectPath(): string | null {
    try {
      const vaultPath = (this.app.vault.adapter as FileSystemAdapter).getBasePath();
      const encoded = vaultPath.replace(/\//g, "-");
      const indexPath = path.join(process.env.HOME || "", ".claude", "projects", encoded, "sessions-index.json");
      if (fs.existsSync(indexPath)) return indexPath;
    } catch { /* ignore */ }
    return null;
  }

  getPluginPath(): string {
    const adapter = this.app.vault.adapter as FileSystemAdapter;
    const basePath = adapter.getBasePath();
    const pluginPath = path.join(basePath, this.app.vault.configDir, "plugins", "claude-code-terminal");
    try {
      return fs.realpathSync(pluginPath);
    } catch {
      return pluginPath;
    }
  }

  async openInSidebar() {
    if (this.isFloatingVisible) {
      this.hideFloatingTerminal();
      this.floatingManager?.destroyAll();
      this.floatingManager = null;
    }

    // Detach any existing instance (could be in center or sidebar)
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_CLAUDE_TERMINAL);

    const rightLeaf = this.app.workspace.getRightLeaf(false);
    if (rightLeaf) {
      await rightLeaf.setViewState({
        type: VIEW_TYPE_CLAUDE_TERMINAL,
        active: true,
      });
      await this.app.workspace.revealLeaf(rightLeaf);
    }
  }

  async openInCenter() {
    if (this.isFloatingVisible) {
      this.hideFloatingTerminal();
      this.floatingManager?.destroyAll();
      this.floatingManager = null;
    }

    // Detach any existing instance (could be in center or sidebar)
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_CLAUDE_TERMINAL);

    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({
      type: VIEW_TYPE_CLAUDE_TERMINAL,
      active: true,
    });
    await this.app.workspace.revealLeaf(leaf);
  }

  undockToFloating() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_CLAUDE_TERMINAL);
    this.showFloatingTerminal();
  }

  saveHighlightsPublic() {
    void this.saveHighlights();
  }

  // ========== Floating Terminal ==========

  private createFloatingContainer() {
    this.floatingContainer = document.createElement("div");
    this.floatingContainer.addClass("claude-terminal-floating", "is-hidden");
    this.floatingContainer.style.width = `${this.settings.floatingWidth}px`;
    this.floatingContainer.style.height = `${this.settings.floatingHeight}px`;

    // Header
    const header = this.floatingContainer.createDiv({ cls: "claude-terminal-header" });
    const headerLeft = header.createDiv({ cls: "claude-terminal-header-left" });
    headerLeft.createSpan({ cls: "claude-terminal-title", text: "Claude terminal" });

    const headerRight = header.createDiv({ cls: "claude-terminal-header-right" });

    const saveBtn = headerRight.createEl("button", { cls: "claude-terminal-btn clickable-icon", attr: { "aria-label": "Save highlights" } });
    setIcon(saveBtn, "save");
    saveBtn.title = "Save highlights";
    saveBtn.addEventListener("click", () => { void this.saveHighlights(); });

    const clearBtn = headerRight.createEl("button", { cls: "claude-terminal-btn clickable-icon", attr: { "aria-label": "Clear terminal" } });
    setIcon(clearBtn, "plus");
    clearBtn.title = "Clear terminal";
    clearBtn.addEventListener("click", () => this.floatingManager?.sendClear());

    const dockBtn = headerRight.createEl("button", { cls: "claude-terminal-btn clickable-icon", attr: { "aria-label": "Open in sidebar" } });
    setIcon(dockBtn, "layout-sidebar-right");
    dockBtn.title = "Open in right sidebar";
    dockBtn.addEventListener("click", () => { void this.openInSidebar(); });

    const minBtn = headerRight.createEl("button", { cls: "claude-terminal-btn clickable-icon", attr: { "aria-label": "Hide" } });
    setIcon(minBtn, "minus");
    minBtn.title = "Hide terminal";
    minBtn.addEventListener("click", () => this.hideFloatingTerminal());

    const closeBtn = headerRight.createEl("button", { cls: "claude-terminal-btn clickable-icon claude-terminal-btn-close", attr: { "aria-label": "Close" } });
    setIcon(closeBtn, "x");
    closeBtn.title = "Close and terminate all sessions";
    closeBtn.addEventListener("click", () => {
      this.hideFloatingTerminal();
      this.floatingManager?.destroyAll();
      this.floatingManager = null;
    });

    // Tab bar
    const floatingTabBar = this.floatingContainer.createDiv({ cls: "claude-terminal-tab-bar" });

    // Sessions container (replaces old single .claude-terminal-content)
    const floatingSessionsContainer = this.floatingContainer.createDiv({ cls: "claude-terminal-content" });

    // Resize handle
    const resizeHandle = this.floatingContainer.createDiv({ cls: "claude-terminal-resize" });

    document.body.appendChild(this.floatingContainer);

    // Store references for lazy manager init
    (this.floatingContainer as any)._tabBar = floatingTabBar;
    (this.floatingContainer as any)._sessionsContainer = floatingSessionsContainer;

    this.setupFloatingDrag(header);
    this.setupFloatingResize(resizeHandle);
  }

  private initFloatingManager() {
    if (this.floatingManager || !this.floatingContainer) return;

    const tabBar = (this.floatingContainer as any)._tabBar as HTMLElement;
    const sessionsContainer = (this.floatingContainer as any)._sessionsContainer as HTMLElement;

    this.floatingManager = new TerminalSessionManager(this, tabBar, sessionsContainer);
  }

  toggleFloatingTerminal() {
    if (this.isFloatingVisible) {
      this.hideFloatingTerminal();
    } else {
      this.showFloatingTerminal();
    }
  }

  showFloatingTerminal() {
    if (!this.floatingContainer) return;

    this.floatingContainer.removeClass("is-hidden");
    this.isFloatingVisible = true;

    if (!this.floatingManager || !this.floatingManager.hasActiveSessions()) {
      this.initFloatingManager();
      this.floatingManager!.createSession();
    } else {
      this.floatingManager.refitActive();
    }
  }

  hideFloatingTerminal() {
    if (!this.floatingContainer) return;
    this.floatingContainer.addClass("is-hidden");
    this.isFloatingVisible = false;
  }

  // ---- Floating drag & resize ----

  private setupFloatingDrag(header: HTMLElement) {
    let isDragging = false;
    let startX: number, startY: number;
    let startRight: number, startBottom: number;

    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging || !this.floatingContainer) return;
      const deltaX = startX - e.clientX;
      const deltaY = startY - e.clientY;
      this.floatingContainer.style.right = `${Math.max(0, startRight + deltaX)}px`;
      this.floatingContainer.style.bottom = `${Math.max(0, startBottom + deltaY)}px`;
    };

    const onMouseUp = () => {
      isDragging = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    header.addEventListener("mousedown", (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest(".claude-terminal-btn")) return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = this.floatingContainer!.getBoundingClientRect();
      startRight = window.innerWidth - rect.right;
      startBottom = window.innerHeight - rect.bottom;
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      e.preventDefault();
    });
  }

  private setupFloatingResize(handle: HTMLElement) {
    let startX: number, startY: number;
    let startWidth: number, startHeight: number;

    const onMouseMove = (e: MouseEvent) => {
      if (!this.floatingContainer) return;
      const deltaX = startX - e.clientX;
      const deltaY = e.clientY - startY;
      const newWidth = Math.min(Math.max(startWidth + deltaX, 300), window.innerWidth * 0.8);
      const newHeight = Math.min(Math.max(startHeight + deltaY, 200), window.innerHeight * 0.8);
      this.floatingContainer.style.width = `${newWidth}px`;
      this.floatingContainer.style.height = `${newHeight}px`;
      this.settings.floatingWidth = newWidth;
      this.settings.floatingHeight = newHeight;
      this.floatingManager?.refitActive();
    };

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      void this.saveSettings();
    };

    handle.addEventListener("mousedown", (e: MouseEvent) => {
      startX = e.clientX;
      startY = e.clientY;
      startWidth = this.floatingContainer?.offsetWidth || 500;
      startHeight = this.floatingContainer?.offsetHeight || 350;
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      e.preventDefault();
    });
  }

  // ---- Highlights ----

  private clearAllHighlights() {
    this.floatingManager?.clearAllHighlights();

    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDE_TERMINAL);
    leaves.forEach(leaf => {
      (leaf.view as ClaudeTerminalView).clearAllHighlights();
    });
  }

  private async saveHighlights() {
    const allHighlights: TerminalHighlight[] = [
      ...(this.floatingManager?.getAllHighlights() ?? []),
    ];

    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDE_TERMINAL);
    leaves.forEach(leaf => {
      allHighlights.push(...(leaf.view as ClaudeTerminalView).getAllHighlights());
    });

    if (allHighlights.length === 0) {
      new Notice("No highlights to save");
      return;
    }

    allHighlights.sort((a, b) => a.timestamp - b.timestamp);

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

    allHighlights.forEach(h => {
      const escapedText = h.text.replace(/\n/g, " ").trim();
      content += `- ${escapedText}\n`;
    });

    const folderPath = this.settings.highlightSavePath;
    const fileName = `Claude Terminal - ${dateStr}.md`;
    const filePath = `${folderPath}/${fileName}`;

    try {
      const adapter = this.app.vault.adapter as FileSystemAdapter;
      const fullFolderPath = path.join(adapter.getBasePath(), folderPath);
      if (!fs.existsSync(fullFolderPath)) {
        fs.mkdirSync(fullFolderPath, { recursive: true });
      }

      const fullFilePath = path.join(adapter.getBasePath(), filePath);
      if (fs.existsSync(fullFilePath)) {
        const existingContent = fs.readFileSync(fullFilePath, "utf-8");
        const newHighlightsSection = content.split("# Claude Terminal Highlights")[1];
        if (newHighlightsSection) {
          fs.appendFileSync(fullFilePath, `\n---\n\n# Session ${timeStr}\n${newHighlightsSection}`);
        }
      } else {
        fs.writeFileSync(fullFilePath, content);
      }

      new Notice(`Saved ${allHighlights.length} highlights to ${fileName}`);
    } catch (error) {
      console.error("Failed to save highlights:", error);
      new Notice("Failed to save highlights");
    }
  }
}

// ========== Settings ==========

class ClaudeTerminalSettingTab extends PluginSettingTab {
  plugin: ClaudeTerminalPlugin;

  constructor(app: App, plugin: ClaudeTerminalPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Shell path")
      .setDesc("Path to the shell executable")
      .addText((text) =>
        text.setPlaceholder("/bin/zsh")
          .setValue(this.plugin.settings.shellPath)
          .onChange(async (value) => {
            this.plugin.settings.shellPath = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Auto-launch claude")
      .setDesc("Automatically run 'claude' command when terminal opens")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoLaunchClaude).onChange(async (value) => {
          this.plugin.settings.autoLaunchClaude = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Font size")
      .setDesc("Terminal font size in pixels")
      .addSlider((slider) =>
        slider.setLimits(10, 24, 1)
          .setValue(this.plugin.settings.fontSize)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.fontSize = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Centered view")
      .setDesc("Constrain the docked terminal to a centered readable column (toggle via command: 'Toggle centered terminal view')")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.centeredView).onChange(async (value) => {
          this.plugin.settings.centeredView = value;
          await this.plugin.saveSettings();
          this.plugin.applyCenteredClassToAllViews();
        })
      );

    containerEl.createEl("h3", { text: "Highlights" });

    new Setting(containerEl)
      .setName("Enable text highlighting")
      .setDesc("Auto-highlight selected text and show the save-to-markdown popup. You can also toggle this from the highlighter button in the tab bar.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.highlightingEnabled).onChange(async (value) => {
          this.plugin.settings.highlightingEnabled = value;
          await this.plugin.saveSettings();
          this.plugin.refreshAllTabBars();
        })
      );

    new Setting(containerEl)
      .setName("Highlight color")
      .setDesc("Background color for text highlights (hex)")
      .addText((text) =>
        text.setPlaceholder("#fef3c7")
          .setValue(this.plugin.settings.highlightColor)
          .onChange(async (value) => {
            this.plugin.settings.highlightColor = value || "#fef3c7";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Highlight save path")
      .setDesc("Folder path in vault where highlights are saved")
      .addText((text) =>
        text.setPlaceholder("3. Resources/Highlights")
          .setValue(this.plugin.settings.highlightSavePath)
          .onChange(async (value) => {
            this.plugin.settings.highlightSavePath = value || "3. Resources/Highlights";
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("h3", { text: "Sessions" });

    new Setting(containerEl)
      .setName("Restore sessions on startup")
      .setDesc("Recreate your previous tabs (names and Claude session IDs) when Obsidian reloads. Shells are spawned fresh — scrollback is not restored.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.restoreSessionsOnStartup).onChange(async (value) => {
          this.plugin.settings.restoreSessionsOnStartup = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Clean copy")
      .setDesc("Strip trailing whitespace from each line and collapse runs of blank lines when copying from the terminal.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.cleanCopy).onChange(async (value) => {
          this.plugin.settings.cleanCopy = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Clear session history")
      .setDesc(`${this.plugin.settings.sessionHistory.length} saved session names`)
      .addButton((btn) =>
        btn.setButtonText("Clear history").onClick(async () => {
          this.plugin.settings.sessionHistory = [];
          await this.plugin.saveSettings();
          this.display();
          new Notice("Session history cleared");
        })
      );
  }
}
