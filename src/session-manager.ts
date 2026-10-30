import { Notice } from "obsidian";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import * as path from "path";
import * as os from "os";
import { promises as fsp } from "fs";
import type {
  PersistedSession,
  RemoteInfo,
  TerminalHighlight,
  TerminalSession,
} from "./types";
import { HighlightController } from "./highlights";
import { TerminalTabBar } from "./tab-bar";
import { makeLocalProbe, watchForClaudeSessionId } from "./claude-session";
import type { ThreadRef } from "./claude-threads";
import { debugLog } from "./debug";
import { buildRemoteLaunchCommand, killRemoteTmuxSession, makeTmuxName, probeRemoteSessionId } from "./remote";
import { cleanCopyText, normalizeCssColor, openExternalLink } from "./text-utils";
import { buildLocalLaunchCommand } from "./launch-command";
import { pastedImagePath, pickPastedImage } from "./image-paste";
import type ClaudeTerminalPlugin from "./main";
import { RECEIPT_ENV, TOKEN_ENV } from "./agent-links";
import { SplitPair, dropFromSplit, inSplit, openSplit, switchInSplit } from "./split-layout";

type NodePtyModule = typeof import("node-pty");

const electronRequire = (window as unknown as { require: NodeJS.Require }).require;

/**
 * Manages a set of terminal sessions sharing one tab bar: lifecycle,
 * PTY wiring, tab rendering, and persistence.
 */
export class TerminalSessionManager {
  private sessions: Map<string, TerminalSession> = new Map();
  private activeSessionId: string | null = null;
  /** Two tabs shown side by side, or null for one tab at a time. */
  private split: SplitPair | null = null;
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
    this.highlighter = new HighlightController(
      () => this.plugin.settings,
      (created) => this.plugin.notifyHighlightsChanged(created),
    );
    this.tabBarUi = new TerminalTabBar(tabBar, {
      onSwitch: (id) => this.switchToSession(id),
      onClose: (id) => this.closeSession(id),
      onRename: (id, name) => this.renameSession(id, name),
      onReorder: (fromId, toId, before) => this.reorderSession(fromId, toId, before),
      onNewSession: (name, resume, claudeSessionId, remote) =>
        this.createSession(name, resume, false, claudeSessionId, remote),
      onForkSession: () => this.forkActiveSession(),
      onSendFeedback: () => this.plugin.openFeedbackModal(),
      onKillRemote: (id) => this.killRemoteSession(id),
      onToggleHighlight: async () => {
        this.plugin.settings.highlightingEnabled = !this.plugin.settings.highlightingEnabled;
        await this.plugin.saveSettings();
        if (this.plugin.settings.highlightingEnabled) {
          this.plugin.highlightNoteSync.startNewSession();
        }
      },
      getSessions: () => this.sessions,
      getActiveSessionId: () => this.activeSessionId,
      onSplit: (id) => this.openSideBySide(id),
      onUnsplit: () => this.closeSideBySide(),
      isInSplit: (id) => inSplit(this.split, id),
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

  /**
   * Fork the active session into a new parallel tab via
   * `claude --resume <id> --fork-session`. Local sessions only, and only once
   * the session's Claude id has been detected (needed as the fork source).
   */
  forkActiveSession() {
    const active = this.activeSessionId ? this.sessions.get(this.activeSessionId) : null;
    if (!active) return;
    if (active.remote) {
      new Notice("Forking is only supported for local sessions.");
      return;
    }
    if (!active.claudeSessionId) {
      new Notice("No Claude session to fork yet — wait for Claude to start.");
      return;
    }
    this.createSession(`${active.name} (fork)`, true, false, active.claudeSessionId, undefined, undefined, true);
  }

  createSession(name?: string, resume = false, isRestored = false, claudeSessionId?: string, remote?: RemoteInfo | boolean, initialInput?: string, fork = false) {
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
    const userNamed = !!name;
    const sessionName = name || `Session ${this.sessions.size + 1}`;

    if (userNamed) {
      this.plugin.addSessionToHistory(sessionName, claudeSessionId || undefined, remoteInfo || undefined);
    }

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
      // Full-screen TUIs (Claude Code fullscreen mode) capture the mouse, so
      // plain drags never create an xterm selection. Shift+drag bypasses the
      // app: xterm's Browser.isMac is false under Electron (a node `process`
      // exists in the renderer), so it always uses its non-Mac shiftKey
      // override. This flag only matters if that detection is ever fixed —
      // then ⌥+drag works too.
      macOptionClickForcesSelection: true,
      scrollback: 10000,
      cols: 80,
      rows: 24,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(content);

    // Make http(s) URLs in terminal output clickable (opens in the system
    // browser). See openExternalLink for how the URL is opened.
    terminal.loadAddon(new WebLinksAddon((_event, uri) => openExternalLink(uri)));

    // Invert xterm's mouse-capture bypass: plain drags always select text
    // (plugin selection color + highlighter), Shift+drag sends the mouse to
    // apps that capture it (Claude Code's fullscreen TUI). Wheel scrolling is
    // reported to the app on a separate path and is unaffected. Uses xterm's
    // private core API — property names survive its minified build (5.5).
    const selectionService = (terminal as unknown as {
      _core?: { _selectionService?: { shouldForceSelection(e: MouseEvent): boolean } };
    })._core?._selectionService;
    if (selectionService) {
      selectionService.shouldForceSelection = (e: MouseEvent) => !e.shiftKey;
    }

    // xterm clears the selection on any user input, and mouse reports count
    // as input — with any-event tracking (Claude Code) every mouse move is a
    // report, so a selection died on the first move after mouseup. Re-send
    // mouse reports (SGR: ESC [< b;x;y M|m) without the user-input flag so
    // only keyboard input clears the selection.
    const coreService = (terminal as unknown as {
      _core?: { coreService?: { triggerDataEvent(data: string, wasUserInput?: boolean): void } };
    })._core?.coreService;
    if (coreService) {
      const origTrigger = coreService.triggerDataEvent.bind(coreService);
      coreService.triggerDataEvent = (data: string, wasUserInput?: boolean) => {
        const isMouseReport = /^\x1b\[<\d+;\d+;\d+[Mm]$/.test(data);
        origTrigger(data, isMouseReport ? false : wasUserInput);
      };
    }

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
      reanchorTimer: null,
      isRestored,
      userNamed,
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

    // Pasting a screenshot: save it to a temp file and paste its path, which
    // Claude Code turns into an image attachment. Capture phase so this runs
    // before xterm's own (text-only) paste handler.
    content.addEventListener("paste", (e: ClipboardEvent) => {
      const item = pickPastedImage(Array.from(e.clipboardData?.items ?? []));
      const file = item?.getAsFile();
      if (!file) return;
      e.preventDefault();
      e.stopPropagation();
      if (session.remote) {
        new Notice("Pasting screenshots only works in local tabs.");
        return;
      }
      void (async () => {
        try {
          const dest = pastedImagePath(os.tmpdir(), new Date(), file.type);
          await fsp.writeFile(dest, Buffer.from(await file.arrayBuffer()));
          terminal.paste(dest);
        } catch (err) {
          new Notice(`Couldn't paste the screenshot: ${String(err)}`);
        }
      })();
    }, true);

    // Auto-highlight on selection (gated by setting)
    let dragStart: { x: number; y: number; alt: boolean; shift: boolean } | null = null;
    terminal.onSelectionChange(() => {
      debugLog(this.plugin.getVaultPath(),
        `selectionChange session=${session.name} selLen=${terminal.getSelection().length} ` +
        `buffer=${terminal.buffer.active.type}`);
    });
    terminal.element?.addEventListener("mousedown", (e) => {
      dragStart = { x: e.clientX, y: e.clientY, alt: e.altKey, shift: e.shiftKey };
      debugLog(this.plugin.getVaultPath(),
        `mousedown session=${session.name} shift=${e.shiftKey} alt=${e.altKey} ` +
        `button=${e.button} detail=${e.detail} mouseTracking=${terminal.modes.mouseTrackingMode} ` +
        `target=${(e.target as HTMLElement)?.className ?? "?"}`);
    });
    terminal.element?.addEventListener("mouseup", (e) => {
      const dragged = dragStart
        && Math.hypot(e.clientX - dragStart.x, e.clientY - dragStart.y) > 10;
      const altHeld = dragStart?.alt ?? false;
      const shiftAtDown = dragStart?.shift ?? false;
      dragStart = null;
      setTimeout(() => {
        const selection = terminal.getSelection();
        debugLog(this.plugin.getVaultPath(),
          `mouseup session=${session.name} hlEnabled=${this.plugin.settings.highlightingEnabled} ` +
          `dragged=${!!dragged} alt=${altHeld} shiftAtDown=${shiftAtDown} shiftAtUp=${e.shiftKey} ` +
          `mouseTracking=${terminal.modes.mouseTrackingMode} ` +
          `buffer=${terminal.buffer.active.type} selLen=${selection.length} ` +
          `selPos=${JSON.stringify(terminal.getSelectionPosition() ?? null)} ` +
          `selBg=${terminal.options.theme?.selectionBackground}`);
        if (!selection || selection.trim().length === 0) return;
        // Copy-on-select, matching the auto-copy Claude Code's own TUI
        // selection did before plain drags stayed in xterm.
        const stripped = selection.replace(/^▎ ?/gm, "");
        void navigator.clipboard.writeText(
          this.plugin.settings.cleanCopy ? cleanCopyText(stripped) : stripped
        );
        if (this.plugin.settings.highlightingEnabled) {
          this.highlighter.createFromSelection(session);
          const last = session.highlights[session.highlights.length - 1];
          debugLog(this.plugin.getVaultPath(),
            `highlight created id=${last?.id} buffer=${last?.bufferType} ` +
            `overlayEls=${last?.overlayEls.length} decorations=${last?.decorations.length}`);
        }
      }, 100);
    });

    this.sessions.set(id, session);
    this.highlighter.attachTerminalListeners(session);

    // Set active state directly (avoid switchToSession's extra rAF + renderTabBar).
    // In side-by-side mode the new tab takes the active side.
    this.split = switchInSplit(this.split, this.activeSessionId, id);
    this.activeSessionId = id;
    this.applyLayout();

    // Side by side: clicking into either pane makes it the active tab.
    container.addEventListener("focusin", () => {
      if (this.split && inSplit(this.split, id) && this.activeSessionId !== id) {
        this.activeSessionId = id;
        this.applyLayout();
        this.renderTabBar();
      }
    });

    // Single rAF: fit, start PTY, focus, render tabs
    requestAnimationFrame(() => {
      fitAddon.fit();
      this.startPty(session, resume, initialInput, fork);
      terminal.focus();
      this.renderTabBar();
    });

    // Resize observer on the content div
    session.resizeObserver = new ResizeObserver(() => {
      if (session.fitDebounceTimer) clearTimeout(session.fitDebounceTimer);
      session.fitDebounceTimer = setTimeout(() => {
        if (session.fitAddon && session.terminal && session.ptyProcess && this.isShown(session.id)) {
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

    this.split = switchInSplit(this.split, this.activeSessionId, id);
    this.activeSessionId = id;
    this.applyLayout();
    this.fitShown();

    this.renderTabBar();
  }

  /** Show `id` beside the active tab. */
  openSideBySide(id: string) {
    const pair = openSplit(this.activeSessionId, id);
    if (!pair || !this.sessions.has(id)) return;
    this.split = pair;
    this.activeSessionId = id;
    this.applyLayout();
    this.fitShown();
    this.renderTabBar();
  }

  closeSideBySide() {
    if (!this.split) return;
    this.split = null;
    this.applyLayout();
    this.fitShown();
    this.renderTabBar();
  }

  private isShown(id: string): boolean {
    return this.split ? inSplit(this.split, id) : this.activeSessionId === id;
  }

  /** Show the active tab, or both tabs of the split (left, right), and hide the rest. */
  private applyLayout() {
    const shown = this.split ? [this.split.left, this.split.right] : [this.activeSessionId];
    this.sessions.forEach(s => {
      const slot = shown.indexOf(s.id);
      s.container.style.display = slot >= 0 ? "flex" : "none";
      s.container.style.order = slot >= 0 ? String(slot) : "";
      s.container.toggleClass("is-split-active", !!this.split && s.id === this.activeSessionId);
      s.container.toggleClass("is-split-right", slot === 1);
    });
    this.sessionsContainer.toggleClass("is-split", !!this.split);
  }

  /** Refit every shown tab and focus the active one. */
  private fitShown() {
    // Double rAF: first ensures display:flex is applied, second ensures layout is computed
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this.sessions.forEach(session => {
          if (!this.isShown(session.id)) return;
          session.fitAddon.fit();
          session.terminal.scrollToBottom();
          if (session.id === this.activeSessionId) session.terminal.focus();
          // Re-anchor pass deferred while the tab was hidden (zero cell dims)
          this.highlighter.refreshOverlays(session);
        });
      });
    });
  }

  closeSession(id: string) {
    const session = this.sessions.get(id);
    if (!session) return;

    this.destroySession(session);
    this.sessions.delete(id);
    const wasSplit = inSplit(this.split, id);
    this.split = dropFromSplit(this.split, id);

    if (this.activeSessionId === id) {
      this.activeSessionId = null;
      const remaining = Array.from(this.sessions.keys());
      if (remaining.length > 0) {
        this.switchToSession(remaining[remaining.length - 1]);
      } else {
        this.createSession();
        return;
      }
    } else if (wasSplit) {
      this.applyLayout();
      this.fitShown();
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
    session.userNamed = true;
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
      if (!s.userNamed) return;
      list.push({ name: s.name, claudeSessionId: s.claudeSessionId || undefined, remote: s.remote || undefined });
    });
    this.plugin.settings.persistedSessions = list;
    void this.plugin.saveSettings();
  }

  /**
   * Snapshot the currently open tabs as thread refs (for saving to a note).
   * Local sessions run at the vault root; remote sessions carry their own path.
   */
  snapshotThreadRefs(): ThreadRef[] {
    const vaultPath = this.plugin.getVaultPath();
    const refs: ThreadRef[] = [];
    this.sessions.forEach(s => {
      refs.push({
        name: s.name,
        session: s.claudeSessionId,
        cwd: s.remote ? s.remote.path : vaultPath,
        remote: s.remote,
      });
    });
    return refs;
  }

  /**
   * Open a saved thread as a new tab, resuming its Claude session. With no
   * session id it starts a fresh conversation: resuming without an id would
   * run `claude --continue` and open whichever conversation was most recent.
   */
  reopenThread(ref: ThreadRef) {
    this.createSession(ref.name, !!ref.session, false, ref.session ?? undefined, ref.remote ?? undefined);
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
    this.split = null;
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
    // Keep a saved thread's vault archive fresh with any conversation since the
    // last save (no-op unless this session was previously saved to a note).
    if (session.claudeSessionId && !session.remote) {
      this.plugin.refreshArchiveIfTracked(session.claudeSessionId, this.plugin.getVaultPath());
    }
    session.resizeObserver?.disconnect();
    if (session.fitDebounceTimer) clearTimeout(session.fitDebounceTimer);
    if (session.reanchorTimer) clearTimeout(session.reanchorTimer);
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

  private startPty(session: TerminalSession, resume = false, initialInput?: string, fork = false) {
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
          // Lets the agent open obsidian://claude-new-tab and claude-feedback links (agent-links.ts).
          [TOKEN_ENV]: this.plugin.settings.agentToken,
          [RECEIPT_ENV]: this.plugin.agentReceiptPath(),
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
      } else if (this.plugin.settings.autoLaunchClaude || initialInput) {
        const cmd = buildLocalLaunchCommand({
          initialInput,
          resume,
          fork,
          claudeSessionId: session.claudeSessionId,
          isFirstSession: this.sessionCounter === 1,
        });
        setTimeout(() => {
          session.ptyProcess?.write(cmd + "\r");
        }, 300);
        setTimeout(() => {
          session.terminal?.scrollToBottom();
        }, 1500);

        // Auto-submit the review prompt once Claude's TUI has had time to come up.
        // The delay is a heuristic; the console also copies the prompt to the
        // clipboard so ⌘V is a reliable fallback if the timing is ever off.
        if (initialInput) {
          setTimeout(() => {
            session.ptyProcess?.write(initialInput + "\r");
          }, 2500);
        }

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
      probe = makeLocalProbe(shellPid, this.plugin.getVaultPath(), launchTime, id => this.isClaimedByOtherTab(session, id));
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
        if (this.isClaimedByOtherTab(session, sessionId)) return; // another tab's session; keep polling
        session.claudeSessionId = sessionId;
        this.plugin.updateSessionHistoryId(session.name, sessionId);
        this.persistSessions();
      },
    });
  }

  /** True when a different open tab already owns this Claude session id. */
  private isClaimedByOtherTab(session: TerminalSession, sessionId: string): boolean {
    for (const s of this.sessions.values()) {
      if (s !== session && s.claudeSessionId === sessionId) return true;
    }
    return false;
  }

  // ---- Tab bar ----

  /** Thin delegator so external call sites (views, floating window) keep a stable API. */
  renderTabBar() {
    this.tabBarUi.render();
  }
}
