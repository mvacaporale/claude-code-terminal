import { Terminal, IDecoration, IMarker } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { IPty } from "node-pty";

export const VIEW_TYPE_CLAUDE_TERMINAL = "claude-terminal-view";

export interface TerminalHighlight {
  id: string;
  text: string;
  timestamp: number;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  decorations: IDecoration[];
  markers: IMarker[];
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
}

export const DEFAULT_SETTINGS: ClaudeTerminalSettings = {
  shellPath: process.platform === "win32" ? "powershell.exe" : process.env.SHELL || "/bin/zsh",
  autoLaunchClaude: true,
  fontSize: 13,
  floatingWidth: 500,
  floatingHeight: 350,
  highlightColor: "#fac832",
  highlightSavePath: "3. Resources/Highlights",
  centeredView: false,
  sessionHistory: [],
  highlightingEnabled: true,
  restoreSessionsOnStartup: true,
  cleanCopy: true,
  persistedSessions: [],
  remoteHost: "",
  remoteVaultPath: "",
};
