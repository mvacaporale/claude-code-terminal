import { FileSystemAdapter, Notice, Plugin, TFile, moment, normalizePath } from "obsidian";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import {
  ClaudeTerminalSettings,
  DEFAULT_SETTINGS,
  RemoteInfo,
  TerminalHighlight,
  VIEW_TYPE_CLAUDE_TERMINAL,
  VIEW_TYPE_REVIEW_CONSOLE,
} from "./types";
import { ClaudeTerminalView } from "./terminal-view";
import { ReviewConsoleView } from "./review-console-view";
import { FloatingWindow } from "./floating-window";
import { ClaudeTerminalSettingTab } from "./settings-tab";
import { saveHighlightsToVault } from "./highlights";
import { HighlightNoteSync } from "./highlight-note";
import { debugLog } from "./debug";
import { ThreadRef, transcriptPath } from "./claude-threads";
import { handleSaveThreads } from "./thread-save";
import { archiveTranscript, rehydrateIfMissing, threadsDir } from "./thread-archive";
import { renderThreadBlock, ThreadReadModal } from "./thread-block-view";
import { FeedbackModal } from "./feedback-modal";
import { persistFeedback } from "./feedback-note";

export default class ClaudeTerminalPlugin extends Plugin {
  settings: ClaudeTerminalSettings = DEFAULT_SETTINGS;
  highlightNoteSync: HighlightNoteSync = new HighlightNoteSync(this);
  private floating: FloatingWindow = new FloatingWindow(this);
  /** One-shot review prompt handed to the next terminal view's first session. */
  private reviewSeed: string | null = null;

  async onload() {
    await this.loadSettings();
    debugLog(this.getVaultPath(), "plugin loaded — debug build hl-diag-5");
    new Notice("Claude Terminal: debug build hl-diag-5 loaded");

    this.registerView(VIEW_TYPE_CLAUDE_TERMINAL, (leaf) => new ClaudeTerminalView(leaf, this));
    this.registerView(VIEW_TYPE_REVIEW_CONSOLE, (leaf) => new ReviewConsoleView(leaf, this));

    this.addRibbonIcon("terminal", "Toggle claude terminal", () => {
      this.floating.toggle();
    });

    this.addRibbonIcon("list-checks", "Open Review Console", () => {
      void this.openReviewConsole();
    });

    this.addRibbonIcon("message-square-plus", "Send feedback to backlog", () => {
      this.openFeedbackModal();
    });

    this.addCommand({
      id: "send-feedback",
      name: "Send feedback to backlog",
      callback: () => this.openFeedbackModal(),
    });

    this.addCommand({
      id: "open-review-console",
      name: "Open Review Console",
      callback: () => { void this.openReviewConsole(); },
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

    // Save a group of open sessions to a note, triggered by the in-terminal agent:
    //   open "obsidian://claude-threads-save?note=<path>&group=<name>&tabs=<name,name>"
    this.registerObsidianProtocolHandler("claude-threads-save", (params) => {
      void handleSaveThreads(this, params);
    });

    // Render saved-thread blocks in notes into a reopen panel.
    this.registerMarkdownCodeBlockProcessor("claude-threads", (source, el) => {
      renderThreadBlock(this, source, el);
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

  // ---- Review Console ----

  /** Open (or reveal) the Review Console in the right sidebar. */
  async openReviewConsole() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_REVIEW_CONSOLE);
    if (existing.length > 0) {
      await this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: VIEW_TYPE_REVIEW_CONSOLE, active: true });
      await this.app.workspace.revealLeaf(leaf);
    }
  }

  /** Consume the one-shot review prompt (terminal view calls this on open). */
  consumeReviewSeed(): string | null {
    const seed = this.reviewSeed;
    this.reviewSeed = null;
    return seed;
  }

  /**
   * Open a fresh Claude terminal session for a review and auto-submit `reviewInput`.
   * Deliberately does NOT use openInCenter/openInSidebar — those detachLeavesOfType()
   * first, which would kill any running terminal sessions. If a terminal is already
   * open we add a review session to it; otherwise we stash a one-shot seed so the new
   * view opens straight into a single fresh review session (no restore, no empty tab).
   */
  async openTerminalForReview(reviewInput: string) {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDE_TERMINAL);
    if (leaves.length > 0) {
      await this.app.workspace.revealLeaf(leaves[0]);
      (leaves[0].view as ClaudeTerminalView).createSession(undefined, reviewInput);
      return;
    }
    this.reviewSeed = reviewInput;
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_CLAUDE_TERMINAL, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  // ---- Feedback ----

  /** Open the in-UI feedback modal, wired to append into the backlog note. */
  openFeedbackModal() {
    new FeedbackModal(this.app, (message, screenshots) => this.submitFeedback(message, screenshots)).open();
  }

  /**
   * Persist a feedback submission into the backlog note (+ screenshots).
   * The routing logic lives in persistFeedback; here we just adapt Obsidian's
   * vault to its injected-deps interface.
   */
  async submitFeedback(message: string, screenshots: Uint8Array[]): Promise<void> {
    const notePath = normalizePath(this.settings.feedbackNotePath);
    await persistFeedback(
      {
        readFileIfExists: async (p) => {
          const f = this.app.vault.getAbstractFileByPath(p);
          return f instanceof TFile ? await this.app.vault.read(f) : null;
        },
        writeFile: async (p, data) => {
          const f = this.app.vault.getAbstractFileByPath(p);
          if (f instanceof TFile) await this.app.vault.modify(f, data);
          else await this.app.vault.create(p, data);
        },
        writeBinary: async (p, data) => {
          await this.app.vault.createBinary(normalizePath(p), data);
        },
        ensureFolder: (p) => this.ensureFolder(normalizePath(p)),
      },
      { message, screenshots, dateStr: moment().format("YYYY-MM-DD"), stamp: Date.now(), notePath }
    );
  }

  private async ensureFolder(dir: string): Promise<void> {
    if (!dir || dir === "." || this.app.vault.getAbstractFileByPath(dir)) return;
    try {
      await this.app.vault.createFolder(dir);
    } catch {
      // Folder was created concurrently or already exists — safe to ignore.
    }
  }

  // ---- Highlights ----

  /** Every live highlight across the floating window and all docked views. */
  collectAllHighlights(): TerminalHighlight[] {
    const allHighlights: TerminalHighlight[] = [...this.floating.getAllHighlights()];
    this.forEachView(view => allHighlights.push(...view.getAllHighlights()));
    return allHighlights;
  }

  /** Every open tab (as a thread ref) across the floating window and all docked views. */
  collectAllThreadRefs(): ThreadRef[] {
    const refs: ThreadRef[] = [...this.floating.snapshotThreadRefs()];
    this.forEachView(view => refs.push(...view.snapshotThreadRefs()));
    return refs;
  }

  /** Restore a purged transcript from the vault archive so `claude --resume` works. */
  private rehydrateThread(vaultPath: string, ref: ThreadRef) {
    if (ref.remote || !ref.session || !ref.archive) return;
    const dest = transcriptPath(os.homedir(), ref.cwd, ref.session);
    rehydrateIfMissing(path.join(threadsDir(vaultPath), ref.archive), dest);
  }

  /** Reopen saved threads as tabs (rehydrating archives first), appending to a terminal. */
  async reopenThreads(refs: ThreadRef[]) {
    if (refs.length === 0) return;
    const vaultPath = this.getVaultPath();
    for (const ref of refs) this.rehydrateThread(vaultPath, ref);

    // Floating window: already on top; just spawn the tabs.
    if (this.floating.isVisible && this.floating.manager) {
      refs.forEach(r => this.floating.reopenThread(r));
      return;
    }
    // Docked view exists: spawn the tabs and switch focus to the terminal.
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDE_TERMINAL);
    if (leaves.length > 0) {
      const view = leaves[0].view as ClaudeTerminalView;
      refs.forEach(r => view.reopenThread(r));
      void this.app.workspace.revealLeaf(leaves[0]);
      return;
    }
    // No terminal open — open one (openInSidebar reveals it), then reopen once
    // its manager has initialized.
    await this.openInSidebar();
    const opened = this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDE_TERMINAL);
    const leaf = opened[0];
    const view = leaf ? (leaf.view as ClaudeTerminalView) : null;
    if (view) {
      window.setTimeout(() => {
        refs.forEach(r => view.reopenThread(r));
        void this.app.workspace.revealLeaf(leaf);
      }, 400);
    } else {
      new Notice("Open a Claude terminal first, then reopen the threads.");
    }
  }

  /** Open the "Read" modal for a saved thread's archived transcript. */
  readThread(ref: ThreadRef) {
    new ThreadReadModal(this, ref).open();
  }

  /**
   * Re-copy a tracked (already-saved) session's transcript so the vault archive
   * captures conversation since the last save. No-op unless an archive already
   * exists for this session id (i.e. it was saved to a note).
   */
  refreshArchiveIfTracked(sessionId: string | null, vaultPath: string) {
    if (!sessionId) return;
    const dir = threadsDir(vaultPath);
    if (!fs.existsSync(path.join(dir, `${sessionId}.jsonl`))) return;
    archiveTranscript(transcriptPath(os.homedir(), vaultPath, sessionId), dir);
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
