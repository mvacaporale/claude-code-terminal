import { Menu, Notice, setIcon } from "obsidian";
import type { ClaudeTerminalSettings, RemoteInfo, SessionHistoryEntry, TerminalSession } from "./types";

/**
 * Narrow interface the tab bar uses to talk back to its owner
 * (the session manager / plugin) without depending on either directly.
 */
export interface TabBarHost {
  onSwitch(id: string): void;
  onClose(id: string): void;
  onRename(id: string, name: string): void;
  onReorder(fromId: string, toId: string, before: boolean): void;
  /** `remote: true` requests a fresh remote session; a RemoteInfo reattaches an existing one. */
  onNewSession(name?: string, resume?: boolean, claudeSessionId?: string, remote?: RemoteInfo | boolean): void;
  onKillRemote(id: string): void;
  onToggleHighlight(): Promise<void>;
  getSessions(): Map<string, TerminalSession>;
  getActiveSessionId(): string | null;
  getSettings(): ClaudeTerminalSettings;
  saveSettings(): Promise<void>;
}

/** Renders the session tab bar: tabs (switch/rename/close/reorder), action buttons, and the history dropdown. */
export class TerminalTabBar {
  private tabBar: HTMLElement;
  private host: TabBarHost;
  private draggedSessionId: string | null = null;
  private clickTimer: NodeJS.Timeout | null = null;
  private clickedTabId: string | null = null;
  private activeHistoryDropdown: HTMLElement | null = null;
  private historyCloseHandler: ((e: MouseEvent) => void) | null = null;

  constructor(tabBar: HTMLElement, host: TabBarHost) {
    this.tabBar = tabBar;
    this.host = host;
  }

  render() {
    const sessions = this.host.getSessions();
    const activeSessionId = this.host.getActiveSessionId();

    // Preserve scroll position across re-renders
    const prevScroll = this.tabBar.querySelector(".claude-terminal-tabs-scroll");
    const savedScrollLeft = prevScroll ? prevScroll.scrollLeft : 0;

    this.tabBar.empty();

    const tabsScroll = this.tabBar.createDiv({ cls: "claude-terminal-tabs-scroll" });

    sessions.forEach((session) => {
      const tab = tabsScroll.createDiv({
        cls: `claude-terminal-tab ${session.id === activeSessionId ? "is-active" : ""}${session.isRestored ? " is-restored" : ""}${session.remote ? " is-remote" : ""}`,
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
        this.host.onReorder(fromId, session.id, before);
      });

      if (session.remote) {
        const remoteIcon = tab.createSpan({
          cls: "claude-terminal-tab-remote-icon",
          attr: { "aria-label": `Remote: ${session.remote.host}` },
        });
        setIcon(remoteIcon, "server");
        remoteIcon.title = `Remote session on ${session.remote.host} (tmux: ${session.remote.tmuxName})`;
      }

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
            this.host.onSwitch(session.id);
          }, 250);
        }
      });

      // Click on tab background (not name) switches immediately
      tab.addEventListener("click", (e) => {
        if (!(e.target as HTMLElement).closest(".claude-terminal-tab-close") &&
            !(e.target as HTMLElement).closest(".claude-terminal-tab-name")) {
          this.host.onSwitch(session.id);
        }
      });

      // Remote tabs: right-click menu with detach vs kill
      if (session.remote) {
        tab.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          const menu = new Menu();
          menu.addItem((item) =>
            item.setTitle("Detach (close tab, keep running)")
              .setIcon("unplug")
              .onClick(() => this.host.onClose(session.id))
          );
          menu.addItem((item) =>
            item.setTitle("Kill remote session")
              .setIcon("trash")
              .setWarning(true)
              .onClick(() => this.host.onKillRemote(session.id))
          );
          menu.showAtMouseEvent(e);
        });
      }

      // Close button (only if more than 1 session)
      if (sessions.size > 1) {
        const closeBtn = tab.createSpan({ cls: "claude-terminal-tab-close" });
        setIcon(closeBtn, "x");
        closeBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          this.host.onClose(session.id);
        });
      }
    });

    // Action buttons wrapper (stays visible even when tabs overflow)
    const actionsWrapper = this.tabBar.createDiv({ cls: "claude-terminal-tab-actions" });

    // Highlighter toggle button
    const highlightOn = this.host.getSettings().highlightingEnabled;
    const highlightBtn = actionsWrapper.createDiv({
      cls: `claude-terminal-tab-action claude-terminal-highlight-toggle ${highlightOn ? "is-active" : "is-disabled"}`,
      attr: { "aria-label": highlightOn ? "Highlighting: on" : "Highlighting: off" },
    });
    setIcon(highlightBtn, "highlighter");
    highlightBtn.title = highlightOn ? "Highlighting: on (click to disable)" : "Highlighting: off (click to enable)";
    highlightBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await this.host.onToggleHighlight();
      this.render();
    });

    // New tab button: click = local, shift+click = remote, right-click = menu
    const newBtn = actionsWrapper.createDiv({ cls: "claude-terminal-tab-action", attr: { "aria-label": "New session" } });
    setIcon(newBtn, "plus");
    newBtn.title = "New session (shift+click: remote, right-click: choose)";
    newBtn.addEventListener("click", (e) =>
      this.host.onNewSession(undefined, false, undefined, e.shiftKey || undefined)
    );
    newBtn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const remoteHost = this.host.getSettings().remoteHost.trim();
      const menu = new Menu();
      menu.addItem((item) =>
        item.setTitle("New local session")
          .setIcon("terminal")
          .onClick(() => this.host.onNewSession())
      );
      // Shown even when unconfigured: clicking surfaces the settings Notice,
      // which is how the remote feature gets discovered.
      menu.addItem((item) =>
        item.setTitle(`New session on ${remoteHost || "remote (not configured)"}`)
          .setIcon("server")
          .onClick(() => this.host.onNewSession(undefined, false, undefined, true))
      );
      menu.showAtMouseEvent(e);
    });

    // History button
    if (this.host.getSettings().sessionHistory.length > 0) {
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
    const session = this.host.getSessions().get(sessionId);
    if (!session) return;

    const input = document.createElement("input");
    input.type = "text";
    input.value = session.name;
    input.className = "claude-terminal-tab-rename";

    const commit = () => {
      this.host.onRename(sessionId, input.value);
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

    const settings = this.host.getSettings();
    const history = settings.sessionHistory;
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
      const row = dropdown.createDiv({ cls: `claude-terminal-history-item${entry.remote ? " is-remote" : ""}` });

      if (entry.remote) {
        const remoteIcon = row.createSpan({
          cls: "claude-terminal-history-remote-icon",
          attr: { "aria-label": `Remote: ${entry.remote.host}` },
        });
        setIcon(remoteIcon, "server");
        remoteIcon.title = `Remote session on ${entry.remote.host}`;
      }

      const nameEl = row.createSpan({ cls: "claude-terminal-history-name", text: entry.name });
      nameEl.addEventListener("click", () => {
        this.closeHistoryMenu();
        this.host.onNewSession(entry.name, true, entry.sessionId, entry.remote);
      });

      const delBtn = row.createSpan({ cls: "claude-terminal-history-delete" });
      setIcon(delBtn, "x");
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const s = this.host.getSettings();
        s.sessionHistory = s.sessionHistory
          .filter((h) => h.name !== entry.name);
        void this.host.saveSettings();
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

  closeHistoryMenu() {
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
