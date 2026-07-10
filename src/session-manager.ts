import { Notice } from "obsidian";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import * as path from "path";
import type {
  PersistedSession,
  RemoteInfo,
  TerminalHighlight,
  TerminalSession,
} from "./types";
import { HighlightController } from "./highlights";
import { TerminalTabBar } from "./tab-bar";
import { makeLocalProbe, watchForClaudeSessionId } from "./claude-session";
import { buildRemoteLaunchCommand, killRemoteTmuxSession, makeTmuxName, probeRemoteSessionId } from "./remote";
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
  private tabBarUi: TerminalTabBar;
  private sessionsContainer: HTMLElement;
  private highlighter: HighlightController;
  private nodePtyModule: NodePtyModule | null = null;
  private persist: boolean;
  private isRestoring = false;

  constructor(plugin: ClaudeTerminalPlugin, tabBar: HTMLElement, sessionsContainer: HTMLElement, persist = false) {
    this.plugin = plugin;
    this.tabBar = tabBar;
    this.sessionsContainer = sessionsContainer;
    this.persist = persist;
    this.highlighter = new HighlightController(() => this.plugin.settings);
    this.tabBarUi = new TerminalTabBar(tabBar, {
      onSwitch: (id) => this.switchToSession(id),
      onClose: (id) => this.closeSession(id),
      onRename: (id, name) => this.renameSession(id, name),
      onReorder: (fromId, toId, before) => this.reorderSession(fromId, toId, before),
      onNewSession: (name, resume, claudeSessionId, remote) =>
        this.createSession(name, resume, false, claudeSessionId, remote),
      onKillRemote: (id) => this.killRemoteSession(id),
      onToggleHighlight: async () => {
        this.plugin.settings.highlightingEnabled = !this.plugin.settings.highlightingEnabled;
        await this.plugin.saveSettings();
      },
      getSessions: () => this.sessions,
      getActiveSessionId: () => this.activeSessionId,
      getSettings: () => this.plugin.settings,
      saveSettings: () => this.plugin.saveSettings(),
    });

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

  createSession(name?: string, resume = false, isRestored = false, claudeSessionId?: string, remote?: RemoteInfo | boolean) {
    // `remote === true` is a fresh UI request: snapshot host/path from
    // settings and mint a tmux name. A RemoteInfo object (restore/history)
    // is used as-is so the tab reattaches its original tmux session.
    let remoteInfo: RemoteInfo | null = null;
    if (remote === true) {
      const host = this.plugin.settings.remoteHost.trim();
      const remotePath = this.plugin.settings.remoteVaultPath.trim();
      if (!host || !remotePath) {
        new Notice("Configure a remote host and working directory in the Claude Terminal settings first.");
        return;
      }
      remoteInfo = { host, path: remotePath, tmuxName: makeTmuxName() };
    } else if (remote) {
      remoteInfo = remote;
    }

    this.sessionCounter++;
    const id = `session-${Date.now()}-${this.sessionCounter}`;
    const sessionName = name || `Session ${this.sessions.size + 1}`;

    this.plugin.addSessionToHistory(sessionName, claudeSessionId || undefined, remoteInfo || undefined);

    const container = this.sessionsContainer.createDiv({ cls: "claude-terminal-session" });
    const content = container.createDiv({ cls: "claude-terminal-session-content" });

    const terminal = new Terminal({
      fontSize: this.plugin.settings.fontSize,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: this.getObsidianTheme(),
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
      remote: remoteInfo,
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
    this.highlighter.attachTerminalListeners(session);

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

  /**
   * Kill the tmux session on the remote host, then close the tab. Fire and
   * forget: killing tmux drops the ssh client anyway, and destroySession
   * kills the local pty regardless.
   */
  killRemoteSession(id: string) {
    const session = this.sessions.get(id);
    if (!session?.remote) return;
    const remote = session.remote;
    killRemoteTmuxSession(remote, (err) => {
      if (err) {
        new Notice(`Failed to kill remote tmux session ${remote.tmuxName} on ${remote.host} (ssh error). It may still be running.`);
      }
    });
    this.closeSession(id);
  }

  renameSession(id: string, newName: string) {
    const session = this.sessions.get(id);
    if (!session) return;
    const trimmed = newName.trim();
    if (trimmed.length === 0) return;
    session.name = trimmed;
    this.plugin.addSessionToHistory(trimmed, session.claudeSessionId || undefined, session.remote || undefined);
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
      list.push({ name: s.name, claudeSessionId: s.claudeSessionId || undefined, remote: s.remote || undefined });
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
        this.createSession(entry.name, true, true, entry.claudeSessionId, entry.remote);
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
    this.tabBarUi.closeHistoryMenu();
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
      // xterm's DOM renderer paints the selection as an OPAQUE blend of this
      // color onto theme.background (allowTransparency doesn't apply to the
      // selection layer), so the values are tuned for the blend result:
      // Obsidian's --text-selection blends to an unreadable navy — don't use it.
      selectionBackground: isDark
        ? "rgba(90, 140, 210, 0.35)" // over #1e1e1e → ~#334560 muted slate
        : "rgba(85, 150, 240, 0.3)", // over #ffffff → ~#cce0fb pastel blue
      selectionInactiveBackground: isDark
        ? "rgba(90, 140, 210, 0.22)"
        : "rgba(85, 150, 240, 0.18)",
    };
  }

  private startPty(session: TerminalSession, resume = false) {
    if (!session.terminal) return;

    try {
      if (!this.nodePtyModule) {
        throw new Error("node-pty module not loaded");
      }

      const vaultPath = this.plugin.getVaultPath();

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

      // Remote sessions always launch (a remote tab that doesn't connect
      // is pointless); local launch stays behind the autoLaunchClaude toggle.
      if (session.remote) {
        const cmd = buildRemoteLaunchCommand(session.remote, session.claudeSessionId);
        setTimeout(() => {
          session.ptyProcess?.write(cmd + "\r");
        }, 300);
        setTimeout(() => {
          session.terminal?.scrollToBottom();
        }, 1500);

        this.detectClaudeSessionId(session);
      } else if (this.plugin.settings.autoLaunchClaude) {
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
    const launchTime = Date.now();
    let probe: () => Promise<string | null>;
    if (session.remote) {
      const remote = session.remote;
      probe = () => probeRemoteSessionId(remote, launchTime);
    } else {
      const shellPid = session.ptyProcess?.pid;
      if (!shellPid) return;
      probe = makeLocalProbe(shellPid, this.plugin.getVaultPath(), launchTime);
    }

    // For restored/resumed sessions, claudeSessionId holds the OLD id:
    // `claude --resume <id>` forks the conversation into a NEW session id.
    // We must detect that new id and re-persist it, otherwise every reload
    // resumes the stale pre-fork snapshot and recent work appears lost.
    const initialId = session.claudeSessionId;

    watchForClaudeSessionId({
      probe,
      isSettled: () =>
        session.claudeSessionId !== null && session.claudeSessionId !== initialId,
      onDetected: (sessionId) => {
        if (sessionId === initialId) return; // stale read; keep polling
        session.claudeSessionId = sessionId;
        this.plugin.updateSessionHistoryId(session.name, sessionId);
        this.persistSessions();
      },
    });
  }

  // ---- Tab bar ----

  /** Thin delegator so external call sites (views, floating window) keep a stable API. */
  renderTabBar() {
    this.tabBarUi.render();
  }
}
