import * as fs from "fs";
import * as path from "path";

/**
 * TEMPORARY diagnostics for the highlighting investigation — appends to
 * .claude-terminal-debug.log in the vault root. Remove once resolved.
 */
export function debugLog(vaultPath: string, msg: string) {
  try {
    fs.appendFileSync(
      path.join(vaultPath, ".claude-terminal-debug.log"),
      `${new Date().toISOString()} ${msg}\n`,
    );
  } catch {
    /* diagnostics must never break the plugin */
  }
}
