import { Terminal, IDecoration, IMarker } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { IPty } from "node-pty";

export const VIEW_TYPE_CLAUDE_TERMINAL = "claude-terminal-view";

export const VIEW_TYPE_REVIEW_CONSOLE = "review-console-view";

/** Vault folder where miciato automations drop job-run notification notes. */
export const REVIEW_FOLDER = "_System/Job Runs/";

export interface TerminalHighlight {
  id: string;
  text: string;
  timestamp: number;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  /** Which buffer the coords refer to; alt-buffer coords are meaningless after a buffer switch. */
  bufferType: "normal" | "alternate";
  /** Normal-buffer rendering (xterm decorations). */
  decorations: IDecoration[];
  markers: IMarker[];
  /** Alt-buffer rendering (plugin-owned overlay divs). */
  overlayEls: HTMLElement[];
  /**
   * Full text of each buffer line the highlight spanned at creation
   * (alt buffer only; empty otherwise). Used to re-find the highlighted
   * text after the TUI redraws — alt-buffer TUIs scroll by repainting.
   */
  anchorLines: string[];
}

/**
 * A session running on a remote host over SSH inside a named tmux session.
 * Host/path are snapshotted at creation so persisted entries stay valid
 * even if the settings change later. tmuxName is generated once and never
 * derived from the (renamable) tab name.
 */
export interface RemoteInfo {
  host: string;
  path: string;
  tmuxName: string;
}

export interface TerminalSession {
  id: string;
  name: string;
  claudeSessionId: string | null;
  remote: RemoteInfo | null;
  terminal: Terminal;
  fitAddon: FitAddon;
  ptyProcess: IPty | null;
  container: HTMLElement;
  highlights: TerminalHighlight[];
  highlightPopup: HTMLElement | null;
  activeHighlightId: string | null;
  hidePopupTimeout: NodeJS.Timeout | null;
  resizeObserver: ResizeObserver | null;
  fitDebounceTimer: NodeJS.Timeout | null;
  reanchorTimer: NodeJS.Timeout | null;
  isRestored: boolean;
}

export interface SessionHistoryEntry {
  name: string;
  sessionId?: string;
  remote?: RemoteInfo;
}

export interface PersistedSession {
  name: string;
  claudeSessionId?: string;
  remote?: RemoteInfo;
}

export interface ClaudeTerminalSettings {
  shellPath: string;
  autoLaunchClaude: boolean;
  fontSize: number;
  floatingWidth: number;
  floatingHeight: number;
  highlightColor: string;
  highlightSavePath: string;
  centeredView: boolean;
  sessionHistory: SessionHistoryEntry[];
  highlightingEnabled: boolean;
  restoreSessionsOnStartup: boolean;
  cleanCopy: boolean;
  persistedSessions: PersistedSession[];
  remoteHost: string;
  remoteVaultPath: string;
  /** Vault-relative note that in-UI feedback is appended to (the triage input). */
  feedbackNotePath: string;
}

export const DEFAULT_SETTINGS: ClaudeTerminalSettings = {
  shellPath: process.platform === "win32" ? "powershell.exe" : process.env.SHELL || "/bin/zsh",
  autoLaunchClaude: true,
  fontSize: 13,
  floatingWidth: 500,
  floatingHeight: 350,
  highlightColor: "#ebc965",
  highlightSavePath: "3. Resources/Highlights",
  centeredView: false,
  sessionHistory: [],
  highlightingEnabled: true,
  restoreSessionsOnStartup: true,
  cleanCopy: true,
  persistedSessions: [],
  remoteHost: "",
  remoteVaultPath: "",
  feedbackNotePath: "5. Code/_index.md",
};
