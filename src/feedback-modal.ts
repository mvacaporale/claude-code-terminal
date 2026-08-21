import { App, Modal, Notice } from "obsidian";
import { captureObsidianWindowPng } from "./screenshot";

const MAX_SHOTS = 3;
const CAPTURE_DELAY_S = 3;

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Called with the feedback text and any captured PNGs when the user submits. */
export type FeedbackSubmit = (message: string, screenshots: Uint8Array[]) => Promise<void>;

/**
 * In-UI feedback modal: free text plus optional screenshots (mirrors the
 * feather-cubed feedback flow). The capture button hides the modal, counts
 * down so the user can set up what they want to show, then snapshots the
 * Obsidian window. `capture` is injectable for testing.
 */
export class FeedbackModal extends Modal {
  private message = "";
  private shots: Uint8Array[] = [];
  private submitting = false;
  private objectUrls: string[] = [];
  private onSubmit: FeedbackSubmit;
  private capture: () => Promise<Uint8Array>;

  constructor(app: App, onSubmit: FeedbackSubmit, capture: () => Promise<Uint8Array> = captureObsidianWindowPng) {
    super(app);
    this.onSubmit = onSubmit;
    this.capture = capture;
  }

  onOpen(): void {
    this.render();
  }

  onClose(): void {
    this.objectUrls.forEach((u) => URL.revokeObjectURL(u));
    this.objectUrls = [];
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("claude-feedback-modal");
    contentEl.createEl("h3", { text: "Send feedback" });

    const textarea = contentEl.createEl("textarea", {
      cls: "claude-feedback-textarea",
      attr: { placeholder: "What's working? What's broken? What's missing?", rows: "4" },
    });
    textarea.value = this.message;
    textarea.addEventListener("input", () => {
      this.message = textarea.value;
      submitBtn.disabled = this.submitting || this.message.trim().length === 0;
    });

    if (this.shots.length > 0) {
      const thumbs = contentEl.createDiv({ cls: "claude-feedback-thumbs" });
      this.shots.forEach((png, i) => {
        const thumb = thumbs.createDiv({ cls: "claude-feedback-thumb" });
        const url = URL.createObjectURL(new Blob([png as BlobPart], { type: "image/png" }));
        this.objectUrls.push(url);
        thumb.createEl("img", { attr: { src: url, alt: `Screenshot ${i + 1}` } });
        const remove = thumb.createEl("button", { cls: "claude-feedback-thumb-remove", text: "✕" });
        remove.setAttr("aria-label", "Remove screenshot");
        remove.addEventListener("click", () => {
          this.shots.splice(i, 1);
          this.render();
        });
      });
    }

    const actions = contentEl.createDiv({ cls: "claude-feedback-actions" });

    const shotBtn = actions.createEl("button", {
      text: this.shots.length > 0 ? "Add another screenshot" : `Screenshot (${CAPTURE_DELAY_S}s delay)`,
    });
    shotBtn.disabled = this.submitting || this.shots.length >= MAX_SHOTS;
    shotBtn.addEventListener("click", () => void this.runCapture());

    const submitBtn = actions.createEl("button", { cls: "mod-cta", text: "Send" });
    submitBtn.disabled = this.submitting || this.message.trim().length === 0;
    submitBtn.addEventListener("click", () => void this.submit());

    textarea.focus();
  }

  private async runCapture(): Promise<void> {
    // Hide the whole modal (dim overlay + dialog) so it isn't in the shot;
    // a small badge counts down while the user sets up what to capture.
    this.containerEl.style.display = "none";
    const badge = document.body.createDiv({ cls: "claude-feedback-badge" });
    try {
      for (let s = CAPTURE_DELAY_S; s > 0; s--) {
        badge.setText(`Capturing in ${s}…`);
        await wait(1000);
      }
      badge.setText("Capturing…");
      const png = await this.capture();
      this.shots.push(png);
    } catch (e) {
      new Notice((e as Error).message);
    } finally {
      badge.remove();
      this.containerEl.style.display = "";
      this.render();
    }
  }

  private async submit(): Promise<void> {
    const message = this.message.trim();
    if (!message || this.submitting) return;
    this.submitting = true;
    this.render();
    try {
      await this.onSubmit(message, this.shots);
      new Notice("Feedback captured to the backlog — thank you!");
      this.close();
    } catch (e) {
      new Notice(`Couldn't save feedback: ${(e as Error).message}`);
      this.submitting = false;
      this.render();
    }
  }
}
