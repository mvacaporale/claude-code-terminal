import { MarkdownRenderer, Modal, setIcon } from "obsidian";
import * as fs from "fs";
import * as path from "path";
import type ClaudeTerminalPlugin from "./main";
import { ThreadRef, parseThreadGroup } from "./claude-threads";
import { renderTranscriptMarkdown, threadsDir } from "./thread-archive";

/**
 * Renders a ```claude-threads block into the "reopen these threads" panel
 * (registered via registerMarkdownCodeBlockProcessor). Buttons delegate the
 * actual work to plugin.reopenThreads / plugin.readThread.
 */
export function renderThreadBlock(plugin: ClaudeTerminalPlugin, source: string, el: HTMLElement): void {
  const group = parseThreadGroup(source);
  if (!group) {
    el.createDiv({ cls: "claude-threads-error", text: "⚠ Unreadable claude-threads block" });
    return;
  }

  const panel = el.createDiv({ cls: "claude-threads-panel" });

  const head = panel.createDiv({ cls: "claude-threads-head" });
  setIcon(head.createSpan({ cls: "claude-threads-ic" }), "layers");
  head.createSpan({ cls: "claude-threads-title", text: group.group });
  head.createSpan({ cls: "claude-threads-count", text: String(group.threads.length) });
  const reopenAll = head.createEl("button", { cls: "claude-threads-reopen" });
  setIcon(reopenAll.createSpan({ cls: "claude-threads-reopen-ic" }), "rotate-ccw");
  reopenAll.createSpan({ text: "Reopen all" });
  reopenAll.addEventListener("click", () => void plugin.reopenThreads(group.threads));

  for (const t of group.threads) {
    const row = panel.createDiv({ cls: "claude-threads-row" });
    row.createSpan({ cls: `claude-threads-dot${t.remote ? " is-remote" : ""}` });
    row.createSpan({ cls: "claude-threads-name", text: t.name });
    if (t.remote) row.createSpan({ cls: "claude-threads-badge", text: t.remote.host });

    const actions = row.createDiv({ cls: "claude-threads-actions" });
    if (t.archive) {
      const readBtn = actions.createEl("button", { cls: "claude-threads-act", text: "Read" });
      readBtn.addEventListener("click", () => plugin.readThread(t));
    }
    const contBtn = actions.createEl("button", { cls: "claude-threads-act is-primary", text: "Continue" });
    contBtn.addEventListener("click", () => void plugin.reopenThreads([t]));
  }
}

/** Modal that renders an archived transcript as readable markdown (the "Read" action). */
export class ThreadReadModal extends Modal {
  constructor(private plugin: ClaudeTerminalPlugin, private ref: ThreadRef) {
    super(plugin.app);
  }

  onOpen(): void {
    this.titleEl.setText(this.ref.name);
    this.contentEl.addClass("claude-threads-read");
    let md: string;
    try {
      if (!this.ref.archive) throw new Error("no archived transcript for this thread");
      const p = path.join(threadsDir(this.plugin.getVaultPath()), this.ref.archive);
      md = renderTranscriptMarkdown(fs.readFileSync(p, "utf8"));
      if (!md.trim()) md = "_This transcript has no readable messages._";
    } catch (e) {
      md = `Could not read the archived transcript.\n\n> ${String(e)}`;
    }
    void MarkdownRenderer.render(this.plugin.app, md, this.contentEl, "", this.plugin);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
