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
  /** True when the tab carries a user-supplied name (rename/restore/fork/reopen);
   * false for auto-named "Session N" tabs. Only user-named sessions are persisted. */
  userNamed: boolean;
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

/**
 * State that must not bleed between vaults. Both vaults symlink this plugin to
 * one folder (one shared data.json), so these fields live in a per-vault slice
 * (see `vaultData`) rather than at the top level.
 */
export interface VaultScopedData {
  persistedSessions: PersistedSession[];
  sessionHistory: SessionHistoryEntry[];
  remoteHost: string;
  remoteVaultPath: string;
  highlightSavePath: string;
}

/** Keys of the settings that are hydrated from / synced to the per-vault slice. */
export const PER_VAULT_KEYS = [
  "persistedSessions",
  "sessionHistory",
  "remoteHost",
  "remoteVaultPath",
  "highlightSavePath",
] as const;

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
  /** "owner/name" of the repo that in-UI feedback is filed into as issues (this plugin's private repo). */
  feedbackRepo: string;
  /** Fine-grained GitHub token with Issues + Contents write on feedbackRepo only. Empty = feedback off. */
  feedbackToken: string;
  /** Per-vault slices keyed by vault base path; see VaultScopedData. */
  vaultData: Record<string, VaultScopedData>;
  /**
   * Immutable snapshot of the pre-scoping shared values, captured once on first
   * load. Any vault opening without its own slice seeds from this, so every
   * vault starts from the same original tab list, then diverges.
   */
  vaultSeed?: VaultScopedData;
}

export const DEFAULT_SETTINGS: ClaudeTerminalSettings = {
  shellPath: process.platform === "win32" ? "powershell.exe" : process.env.SHELL || "/bin/zsh",
  autoLaunchClaude: true,
  fontSize: 13,
  floatingWidth: 500,
  floatingHeight: 350,
  highlightColor: "#ebc965",
  highlightSavePath: "highlights",
  centeredView: false,
  sessionHistory: [],
  highlightingEnabled: true,
  restoreSessionsOnStartup: true,
  cleanCopy: true,
  persistedSessions: [],
  remoteHost: "",
  remoteVaultPath: "",
  feedbackRepo: "mvacaporale/claude-code-terminal",
  feedbackToken: "",
  vaultData: {},
};
