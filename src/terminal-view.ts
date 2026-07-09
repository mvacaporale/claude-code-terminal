import { ItemView, Menu, Notice, WorkspaceLeaf } from "obsidian";
import { TerminalSessionManager } from "./session-manager";
import { VIEW_TYPE_CLAUDE_TERMINAL, TerminalHighlight } from "./types";
import type ClaudeTerminalPlugin from "./main";

/** Docked terminal view (sidebar or main editor area). */
export class ClaudeTerminalView extends ItemView {
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
        .onClick(() => { void this.plugin.saveHighlights(); });
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
