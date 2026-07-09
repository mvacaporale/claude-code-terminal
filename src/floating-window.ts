import { setIcon } from "obsidian";
import { TerminalSessionManager } from "./session-manager";
import type { TerminalHighlight } from "./types";
import type ClaudeTerminalPlugin from "./main";

/**
 * The floating terminal panel: container DOM, drag/resize behavior, and a
 * lazily created session manager (sessions only spawn on first show).
 */
export class FloatingWindow {
  private plugin: ClaudeTerminalPlugin;
  private containerEl: HTMLElement | null = null;
  private tabBarEl: HTMLElement | null = null;
  private sessionsEl: HTMLElement | null = null;
  private sessionManager: TerminalSessionManager | null = null;
  private visible = false;

  constructor(plugin: ClaudeTerminalPlugin) {
    this.plugin = plugin;
  }

  get isVisible(): boolean {
    return this.visible;
  }

  get manager(): TerminalSessionManager | null {
    return this.sessionManager;
  }

  /** Build the (hidden) container DOM. Called once on layout ready. */
  create() {
    this.containerEl = document.createElement("div");
    this.containerEl.addClass("claude-terminal-floating", "is-hidden");
    this.containerEl.style.width = `${this.plugin.settings.floatingWidth}px`;
    this.containerEl.style.height = `${this.plugin.settings.floatingHeight}px`;

    // Header
    const header = this.containerEl.createDiv({ cls: "claude-terminal-header" });
    const headerLeft = header.createDiv({ cls: "claude-terminal-header-left" });
    headerLeft.createSpan({ cls: "claude-terminal-title", text: "Claude terminal" });

    const headerRight = header.createDiv({ cls: "claude-terminal-header-right" });

    const saveBtn = headerRight.createEl("button", { cls: "claude-terminal-btn clickable-icon", attr: { "aria-label": "Save highlights" } });
    setIcon(saveBtn, "save");
    saveBtn.title = "Save highlights";
    saveBtn.addEventListener("click", () => { void this.plugin.saveHighlights(); });

    const clearBtn = headerRight.createEl("button", { cls: "claude-terminal-btn clickable-icon", attr: { "aria-label": "Clear terminal" } });
    setIcon(clearBtn, "eraser");
    clearBtn.title = "Clear terminal";
    clearBtn.addEventListener("click", () => this.sessionManager?.sendClear());

    const dockBtn = headerRight.createEl("button", { cls: "claude-terminal-btn clickable-icon", attr: { "aria-label": "Open in sidebar" } });
    setIcon(dockBtn, "layout-sidebar-right");
    dockBtn.title = "Open in right sidebar";
    dockBtn.addEventListener("click", () => { void this.plugin.openInSidebar(); });

    const minBtn = headerRight.createEl("button", { cls: "claude-terminal-btn clickable-icon", attr: { "aria-label": "Hide" } });
    setIcon(minBtn, "minus");
    minBtn.title = "Hide terminal";
    minBtn.addEventListener("click", () => this.hide());

    const closeBtn = headerRight.createEl("button", { cls: "claude-terminal-btn clickable-icon claude-terminal-btn-close", attr: { "aria-label": "Close" } });
    setIcon(closeBtn, "x");
    closeBtn.title = "Close and terminate all sessions";
    closeBtn.addEventListener("click", () => this.closeAndTerminate());

    this.tabBarEl = this.containerEl.createDiv({ cls: "claude-terminal-tab-bar" });
    this.sessionsEl = this.containerEl.createDiv({ cls: "claude-terminal-content" });

    const resizeHandle = this.containerEl.createDiv({ cls: "claude-terminal-resize" });

    document.body.appendChild(this.containerEl);

    this.setupDrag(header);
    this.setupResize(resizeHandle);
  }

  /** Tear down everything (plugin unload). */
  destroy() {
    this.sessionManager?.destroyAll();
    this.sessionManager = null;
    this.containerEl?.remove();
    this.containerEl = null;
  }

  toggle() {
    if (this.visible) {
      this.hide();
    } else {
      this.show();
    }
  }

  show() {
    if (!this.containerEl) return;

    this.containerEl.removeClass("is-hidden");
    this.visible = true;

    if (!this.sessionManager || !this.sessionManager.hasActiveSessions()) {
      if (!this.sessionManager && this.tabBarEl && this.sessionsEl) {
        this.sessionManager = new TerminalSessionManager(this.plugin, this.tabBarEl, this.sessionsEl);
      }
      this.sessionManager?.createSession();
    } else {
      this.sessionManager.refitActive();
    }
  }

  hide() {
    if (!this.containerEl) return;
    this.containerEl.addClass("is-hidden");
    this.visible = false;
  }

  /** Hide the panel and kill all its sessions. */
  closeAndTerminate() {
    this.hide();
    this.sessionManager?.destroyAll();
    this.sessionManager = null;
  }

  createSession() {
    this.sessionManager?.createSession();
  }

  refreshTheme() {
    this.sessionManager?.refreshTheme();
  }

  renderTabBar() {
    this.sessionManager?.renderTabBar();
  }

  getAllHighlights(): TerminalHighlight[] {
    return this.sessionManager?.getAllHighlights() ?? [];
  }

  clearAllHighlights() {
    this.sessionManager?.clearAllHighlights();
  }

  // ---- Drag & resize ----

  private setupDrag(header: HTMLElement) {
    let isDragging = false;
    let startX: number, startY: number;
    let startRight: number, startBottom: number;

    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging || !this.containerEl) return;
      const deltaX = startX - e.clientX;
      const deltaY = startY - e.clientY;
      this.containerEl.style.right = `${Math.max(0, startRight + deltaX)}px`;
      this.containerEl.style.bottom = `${Math.max(0, startBottom + deltaY)}px`;
    };

    const onMouseUp = () => {
      isDragging = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    header.addEventListener("mousedown", (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest(".claude-terminal-btn")) return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = this.containerEl!.getBoundingClientRect();
      startRight = window.innerWidth - rect.right;
      startBottom = window.innerHeight - rect.bottom;
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      e.preventDefault();
    });
  }

  private setupResize(handle: HTMLElement) {
    let startX: number, startY: number;
    let startWidth: number, startHeight: number;

    const onMouseMove = (e: MouseEvent) => {
      if (!this.containerEl) return;
      const deltaX = startX - e.clientX;
      const deltaY = e.clientY - startY;
      const newWidth = Math.min(Math.max(startWidth + deltaX, 300), window.innerWidth * 0.8);
      const newHeight = Math.min(Math.max(startHeight + deltaY, 200), window.innerHeight * 0.8);
      this.containerEl.style.width = `${newWidth}px`;
      this.containerEl.style.height = `${newHeight}px`;
      this.plugin.settings.floatingWidth = newWidth;
      this.plugin.settings.floatingHeight = newHeight;
      this.sessionManager?.refitActive();
    };

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      void this.plugin.saveSettings();
    };

    handle.addEventListener("mousedown", (e: MouseEvent) => {
      startX = e.clientX;
      startY = e.clientY;
      startWidth = this.containerEl?.offsetWidth || 500;
      startHeight = this.containerEl?.offsetHeight || 350;
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      e.preventDefault();
    });
  }
}
