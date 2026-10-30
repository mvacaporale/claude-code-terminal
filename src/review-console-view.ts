import { ItemView, WorkspaceLeaf, TFile, setIcon, Notice } from "obsidian";
import { VIEW_TYPE_REVIEW_CONSOLE, REVIEW_FOLDER } from "./types";
import type ClaudeTerminalPlugin from "./main";

interface ReviewItem {
  file: TFile;
  job: string;
  summary: string;
  reviewPrompt: string | null;
  sortKey: number;
}

type Mode = "pending" | "reviewed";

/**
 * A pane listing "review output" job-run notes (status: success) from REVIEW_FOLDER,
 * each with a one-click launch into a fresh Claude terminal session. Two tabs: Pending
 * (unreviewed) and Reviewed (history). Failures are excluded — those live in the Bases
 * "Failures" panel.
 */
export class ReviewConsoleView extends ItemView {
  private plugin: ClaudeTerminalPlugin;
  private mode: Mode = "pending";
  private listEl: HTMLElement | null = null;
  private countEl: HTMLElement | null = null;
  private emptyEl: HTMLElement | null = null;
  private pendingTab: HTMLElement | null = null;
  private reviewedTab: HTMLElement | null = null;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: ClaudeTerminalPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_REVIEW_CONSOLE;
  }

  getDisplayText(): string {
    return "Review Console";
  }

  getIcon(): string {
    return "list-checks";
  }

  async onOpen(): Promise<void> {
    await super.onOpen();
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("review-console-view");

    const header = container.createDiv({ cls: "review-console-header" });
    const top = header.createDiv({ cls: "review-console-header-top" });
    const title = top.createDiv({ cls: "review-console-title" });
    title.createSpan({ text: "Review Console" });
    this.countEl = title.createSpan({ cls: "review-console-count", text: "0" });
    const refreshBtn = top.createEl("button", {
      cls: "clickable-icon review-console-refresh",
      attr: { "aria-label": "Refresh" },
    });
    setIcon(refreshBtn, "rotate-cw");
    refreshBtn.addEventListener("click", () => this.render());

    const tabs = header.createDiv({ cls: "review-console-tabs" });
    this.pendingTab = tabs.createEl("button", { cls: "review-console-tab", text: "Pending" });
    this.reviewedTab = tabs.createEl("button", { cls: "review-console-tab", text: "Reviewed" });
    this.pendingTab.addEventListener("click", () => this.setMode("pending"));
    this.reviewedTab.addEventListener("click", () => this.setMode("reviewed"));
    this.updateTabs();

    this.listEl = container.createDiv({ cls: "review-console-list" });
    this.emptyEl = container.createDiv({ cls: "review-console-empty" });

    // Auto-refresh. metadataCache 'changed' fires AFTER frontmatter is reparsed, so a
    // just-reviewed note won't flicker back. registerEvent auto-cleans on view close.
    this.registerEvent(this.app.metadataCache.on("changed", () => this.scheduleRender()));
    this.registerEvent(this.app.vault.on("delete", () => this.scheduleRender()));
    this.registerEvent(this.app.vault.on("rename", () => this.scheduleRender()));

    this.render();
  }

  async onClose(): Promise<void> {
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
    await super.onClose();
  }

  private setMode(mode: Mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.updateTabs();
    this.render();
  }

  private updateTabs() {
    this.pendingTab?.toggleClass("is-active", this.mode === "pending");
    this.reviewedTab?.toggleClass("is-active", this.mode === "reviewed");
  }

  private scheduleRender() {
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.render();
    }, 250);
  }

  // ---- Data ----

  private getItems(): ReviewItem[] {
    const wantReviewed = this.mode === "reviewed";
    const items: ReviewItem[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!file.path.startsWith(REVIEW_FOLDER)) continue;
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (!fm) continue;
      if (fm.type !== "job-run") continue;
      if (fm.status !== "success") continue;
      const isReviewed = String(fm.reviewed).toLowerCase() === "true";
      if (isReviewed !== wantReviewed) continue;
      items.push({
        file,
        job: String(fm.job ?? file.basename),
        summary: fm.summary != null ? String(fm.summary) : "",
        reviewPrompt: fm.review_prompt != null ? String(fm.review_prompt) : null,
        sortKey: this.parseSortKey(fm.last_edited, file.stat.mtime),
      });
    }
    items.sort((a, b) => b.sortKey - a.sortKey);
    return items;
  }

  private parseSortKey(lastEdited: unknown, mtime: number): number {
    if (lastEdited != null) {
      const s = String(lastEdited);
      // Parse a YYYY-MM-DD as a LOCAL date so relative labels don't drift a day.
      const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
      const t = Date.parse(s);
      if (!Number.isNaN(t)) return t;
    }
    return mtime;
  }

  // ---- Render ----

  private render() {
    if (!this.listEl || !this.emptyEl || !this.countEl) return;
    const items = this.getItems();
    this.countEl.setText(String(items.length));
    this.listEl.empty();
    this.emptyEl.setText(
      this.mode === "reviewed" ? "No reviewed items yet." : "You're caught up — no reviews pending."
    );

    if (items.length === 0) {
      this.listEl.style.display = "none";
      this.emptyEl.style.display = "flex";
      return;
    }
    this.emptyEl.style.display = "none";
    this.listEl.style.display = "flex";
    for (const item of items) {
      this.listEl.appendChild(this.renderRow(item));
    }
  }

  private renderRow(item: ReviewItem): HTMLElement {
    const reviewed = this.mode === "reviewed";
    const row = createDiv({ cls: "review-console-row", attr: { tabindex: "0" } });

    const main = row.createDiv({ cls: "review-console-main" });
    main.createSpan({ cls: "review-console-slug", text: item.job });
    main.createDiv({ cls: "review-console-summary", text: item.summary || "(no summary)" });

    // Right slot: the date at rest, compact icon actions on hover.
    const side = row.createDiv({ cls: "review-console-side" });
    side.createSpan({ cls: "review-console-time", text: this.formatTs(item.sortKey) });
    const actions = side.createDiv({ cls: "review-console-actions" });

    const iconBtn = (icon: string, label: string, primary: boolean, handler: () => void) => {
      const b = actions.createEl("button", {
        cls: "clickable-icon review-console-iconbtn" + (primary ? " is-primary" : ""),
        attr: { "aria-label": label },
      });
      setIcon(b, icon);
      b.addEventListener("click", (e) => { e.stopPropagation(); handler(); });
    };
    iconBtn("bot", "Review with Claude", true, () => void this.onReview(item));
    iconBtn("file-text", "Open note", false, () => this.onOpenNote(item));
    iconBtn(
      reviewed ? "rotate-ccw" : "check",
      reviewed ? "Re-open" : "Mark reviewed",
      false,
      () => void this.setReviewed(item, !reviewed, row),
    );

    return row;
  }

  private formatTs(ms: number): string {
    const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const diffDays = Math.round((startOfDay(new Date()) - startOfDay(new Date(ms))) / 86400000);
    if (diffDays <= 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return `${diffDays}d ago`;
    return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  // ---- Actions ----

  private async onReview(item: ReviewItem) {
    const prompt = this.buildPrompt(item);
    // Also copy the prompt so ⌘V is a fallback if the auto-submit timing is ever off.
    await this.copyToClipboard(prompt);
    await this.plugin.openTerminalWithPrompt(prompt);
    new Notice("Opening Claude with your review prompt…");
  }

  /** A single-line prompt: it's written to the pty and submitted with one Enter. */
  private buildPrompt(item: ReviewItem): string {
    if (item.reviewPrompt && item.reviewPrompt.trim()) {
      return item.reviewPrompt.replace(/\s*\n\s*/g, " ").trim();
    }
    const parts = [`Please review the note "${item.file.path}".`];
    if (item.summary) parts.push(item.summary);
    parts.push("Walk me through what the job produced and flag anything worth acting on.");
    return parts.join(" ");
  }

  private async copyToClipboard(text: string): Promise<boolean> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) {
      /* fall through to the legacy path */
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (_) {
      return false;
    }
  }

  private onOpenNote(item: ReviewItem) {
    void this.app.workspace.openLinkText(item.file.path, "", false);
  }

  private async setReviewed(item: ReviewItem, value: boolean, row: HTMLElement) {
    try {
      await this.app.fileManager.processFrontMatter(item.file, (fm) => {
        fm.reviewed = value;
      });
      // Optimistic removal for instant feedback; the debounced re-render reconciles.
      row.remove();
      const remaining = this.listEl?.childElementCount ?? 0;
      this.countEl?.setText(String(remaining));
      if (remaining === 0 && this.emptyEl && this.listEl) {
        this.listEl.style.display = "none";
        this.emptyEl.style.display = "flex";
      }
    } catch (e) {
      new Notice("Couldn't update note: " + (e as Error).message);
    }
  }
}
