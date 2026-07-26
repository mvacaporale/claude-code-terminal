import { FileSystemAdapter, Notice, Plugin } from "obsidian";
import * as path from "path";
import * as fs from "fs";
import {
  ClaudeTerminalSettings,
  DEFAULT_SETTINGS,
  RemoteInfo,
  TerminalHighlight,
  VIEW_TYPE_CLAUDE_TERMINAL,
} from "./types";
import { ClaudeTerminalView } from "./terminal-view";
import { FloatingWindow } from "./floating-window";
import { ClaudeTerminalSettingTab } from "./settings-tab";
import { saveHighlightsToVault } from "./highlights";
import { HighlightNoteSync } from "./highlight-note";
import { debugLog } from "./debug";

export default class ClaudeTerminalPlugin extends Plugin {
  settings: ClaudeTerminalSettings = DEFAULT_SETTINGS;
  highlightNoteSync: HighlightNoteSync = new HighlightNoteSync(this);
  private floating: FloatingWindow = new FloatingWindow(this);

  async onload() {
    await this.loadSettings();
    debugLog(this.getVaultPath(), "plugin loaded — debug build hl-diag-5");
    new Notice("Claude Terminal: debug build hl-diag-5 loaded");

    this.registerView(VIEW_TYPE_CLAUDE_TERMINAL, (leaf) => new ClaudeTerminalView(leaf, this));

    this.addRibbonIcon("terminal", "Toggle claude terminal", () => {
      this.floating.toggle();
    });

    this.addCommand({
      id: "toggle-claude-terminal",
      name: "Toggle claude terminal (floating)",
      callback: () => this.floating.toggle(),
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
        if (this.floating.isVisible && this.floating.manager) {
          this.floating.createSession();
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
      this.floating.create();
    });
  }

  onunload() {
    this.floating.destroy();
  }

  // ---- Settings ----

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    let migrated = false;

    // Migrate old string[] format to SessionHistoryEntry[]
    if (this.settings.sessionHistory.length > 0 && typeof this.settings.sessionHistory[0] === "string") {
      this.settings.sessionHistory = (this.settings.sessionHistory as unknown as string[]).map(name => ({ name }));
      migrated = true;
    }

    // Old default highlight colors: #fef3c7 predates the setting being wired
    // up (nearly invisible on light backgrounds); #fac832 was too saturated.
    // Move users who never customized the color to the current default.
    const oldColor = this.settings.highlightColor.toLowerCase();
    if (oldColor === "#fef3c7" || oldColor === "#fac832") {
      this.settings.highlightColor = DEFAULT_SETTINGS.highlightColor;
      migrated = true;
    }

    if (migrated) {
      void this.saveSettings();
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ---- Session history ----

  addSessionToHistory(name: string, sessionId?: string, remote?: RemoteInfo) {
    const history = this.settings.sessionHistory;
    // Preserve a previously detected session id when re-adding the same name
    // without one (e.g. a fresh tab created before detection has run) —
    // otherwise the history entry's resume target gets wiped.
    const existing = history.find(e => e.name === name);
    const filtered = history.filter(e => e.name !== name);
    filtered.push({ name, sessionId: sessionId ?? existing?.sessionId, remote: remote ?? existing?.remote });
    if (filtered.length > 30) {
      filtered.splice(0, filtered.length - 30);
    }
    this.settings.sessionHistory = filtered;
    void this.saveSettings();
  }

  updateSessionHistoryId(name: string, sessionId: string) {
    const entry = this.settings.sessionHistory.find(e => e.name === name);
    if (entry) {
      entry.sessionId = sessionId;
      void this.saveSettings();
    }
  }

  // ---- View helpers ----

  private forEachView(fn: (view: ClaudeTerminalView) => void) {
    this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDE_TERMINAL).forEach((leaf) => {
      if (leaf.view instanceof ClaudeTerminalView) {
        fn(leaf.view);
      }
    });
  }

  private refreshAllTerminalThemes() {
    this.forEachView(view => view.refreshTheme());
    this.floating.refreshTheme();
  }

  refreshAllTabBars() {
    this.floating.renderTabBar();
    this.forEachView(view => view.refreshTabBar());
  }

  applyCenteredClassToAllViews() {
    this.forEachView(view => view.applyCenteredClass());
  }

  /** Absolute filesystem path of the vault root (single home for the adapter cast). */
  getVaultPath(): string {
    return (this.app.vault.adapter as FileSystemAdapter).getBasePath();
  }

  getPluginPath(): string {
    const pluginPath = path.join(this.getVaultPath(), this.app.vault.configDir, "plugins", "claude-code-terminal");
    try {
      return fs.realpathSync(pluginPath);
    } catch {
      return pluginPath;
    }
  }

  // ---- Docking ----

  async openInSidebar() {
    if (this.floating.isVisible) {
      this.floating.closeAndTerminate();
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
    if (this.floating.isVisible) {
      this.floating.closeAndTerminate();
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
    this.floating.show();
  }

  // ---- Highlights ----

  /** Every live highlight across the floating window and all docked views. */
  collectAllHighlights(): TerminalHighlight[] {
    const allHighlights: TerminalHighlight[] = [...this.floating.getAllHighlights()];
    this.forEachView(view => allHighlights.push(...view.getAllHighlights()));
    return allHighlights;
  }

  /** Called by highlight controllers after any create/merge/delete/clear. */
  notifyHighlightsChanged(created: boolean) {
    this.highlightNoteSync.onHighlightsChanged(created);
  }

  async saveHighlights() {
    await saveHighlightsToVault(this.getVaultPath(), this.settings, this.collectAllHighlights());
  }

  private clearAllHighlights() {
    this.floating.clearAllHighlights();
    this.forEachView(view => view.clearAllHighlights());
  }
}
