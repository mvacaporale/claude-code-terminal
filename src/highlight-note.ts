import { MarkdownView, TFile, WorkspaceLeaf, normalizePath } from "obsidian";
import { VIEW_TYPE_CLAUDE_TERMINAL } from "./types";
import { buildSessionBody, initialNoteContent, upsertSessionSection } from "./highlight-note-format";
import type ClaudeTerminalPlugin from "./main";

/**
 * Keeps a daily note mirroring the current highlighting session. A session
 * starts on the first highlight after plugin load, or whenever the
 * highlighter toggle is switched on; each session owns one "## Session HH:MM"
 * section whose bullets are regenerated on every highlight change, so
 * merges and deletions are reflected too. Only the current session's section
 * is ever rewritten — earlier sections are frozen.
 */
export class HighlightNoteSync {
  private sessionHeading: string | null = null;
  /** Highlights created before this instant belong to earlier sessions. */
  private sessionStartTs = 0;
  private notePath: string | null = null;
  private noteDateStr: string | null = null;
  /** Serializes note operations so rapid highlight events can't interleave. */
  private queue: Promise<void> = Promise.resolve();

  constructor(private plugin: ClaudeTerminalPlugin) {}

  /** Highlighter toggled on: begin a fresh session section and reveal the note. */
  startNewSession() {
    this.enqueue(async () => {
      this.sessionHeading = null;
      this.sessionStartTs = Date.now();
      await this.ensureSession();
    });
  }

  onHighlightsChanged(created: boolean) {
    this.enqueue(async () => {
      if (!this.sessionHeading) {
        // Don't let a stray deletion/clear open a session note by itself.
        if (!created) return;
        await this.ensureSession();
      }
      await this.syncSection();
    });
  }

  // ---- Private ----

  private enqueue(op: () => Promise<void>) {
    this.queue = this.queue.then(op).catch(err => {
      console.error("Claude Terminal: highlight note sync failed", err);
    });
  }

  private async ensureSession() {
    const now = new Date();
    this.noteDateStr = now.toISOString().split("T")[0];
    this.notePath = normalizePath(
      `${this.plugin.settings.highlightSavePath}/Claude Terminal - ${this.noteDateStr}.md`,
    );
    const file = await this.ensureNoteFile();
    const timeStr = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
    this.sessionHeading = `## Session ${timeStr}`;
    await this.plugin.app.vault.process(file, content =>
      upsertSessionSection(content, this.sessionHeading!, ""),
    );
    await this.revealNote(file);
  }

  private async ensureNoteFile(): Promise<TFile> {
    const vault = this.plugin.app.vault;
    const existing = vault.getAbstractFileByPath(this.notePath!);
    if (existing instanceof TFile) return existing;

    // Build the folder chain segment by segment (createFolder is not recursive
    // in all API versions).
    const folder = normalizePath(this.plugin.settings.highlightSavePath);
    let current = "";
    for (const segment of folder.split("/")) {
      current = current ? `${current}/${segment}` : segment;
      if (!vault.getAbstractFileByPath(current)) {
        await vault.createFolder(current).catch(() => {});
      }
    }
    return vault.create(this.notePath!, initialNoteContent(this.noteDateStr!));
  }

  private async syncSection() {
    if (!this.sessionHeading || !this.notePath) return;
    // Recreated on demand in case the note was deleted mid-session.
    const file = await this.ensureNoteFile();
    const highlights = this.plugin
      .collectAllHighlights()
      .filter(h => h.timestamp >= this.sessionStartTs);
    await this.plugin.app.vault.process(file, content =>
      upsertSessionSection(content, this.sessionHeading!, buildSessionBody(highlights)),
    );
  }

  private async revealNote(file: TFile) {
    const workspace = this.plugin.app.workspace;

    let target: WorkspaceLeaf | null = null;
    workspace.iterateAllLeaves(leaf => {
      if (!target && leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path) {
        target = leaf;
      }
    });

    if (!target) {
      let leaf = workspace.getRightLeaf(false);
      // getRightLeaf(false) can hand back an occupied leaf — never clobber a
      // docked terminal with the note.
      if (!leaf || leaf.view.getViewType() === VIEW_TYPE_CLAUDE_TERMINAL) {
        leaf = workspace.getRightLeaf(true);
      }
      if (!leaf) return;
      await leaf.openFile(file, { active: false });
      target = leaf;
    }

    await workspace.revealLeaf(target);
  }
}
