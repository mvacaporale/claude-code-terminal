import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const LOG = path.join(os.homedir(), "Library", "Logs", "claude-code-terminal-autoupdate.log");

/**
 * Pulls main and rebuilds the plugin checkout via scripts/mac-autoupdate.sh, so merging a PR
 * "deploys" on the next Obsidian launch or reload. Resolves to the new short commit when an
 * update was built (it takes effect on the following reload), or null when nothing changed.
 */
export function selfUpdate(pluginPath: string): Promise<string | null> {
  const script = path.join(pluginPath, "scripts", "mac-autoupdate.sh");
  if (process.platform !== "darwin" || !fs.existsSync(script)) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile("/bin/bash", [script], { cwd: pluginPath, timeout: 10 * 60 * 1000 }, (err, stdout, stderr) => {
      const out = `${stdout}${stderr}${err ? `${err.message}\n` : ""}`;
      if (out) fs.appendFile(LOG, out, () => undefined);
      resolve(err ? null : (/updated to (\w+)/.exec(stdout)?.[1] ?? null));
    });
  });
}
