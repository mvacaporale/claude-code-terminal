import * as fs from "fs";
import * as path from "path";

/**
 * Archival + rehydration for Claude transcripts.
 *
 * Claude Code purges its transcripts (~/.claude/projects/<enc>/<id>.jsonl) after
 * cleanupPeriodDays (default 30), so a saved thread would stop being resumable.
 * We copy the transcript into the vault's .claude/threads/ (durable, syncs) and,
 * before a resume, copy it back if the live file is gone — which fully restores
 * resumability including conversation context (proven end-to-end).
 */

/** The vault-local archive directory: <vaultPath>/.claude/threads */
export function threadsDir(vaultPath: string): string {
  return path.join(vaultPath, ".claude", "threads");
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Copy a live transcript into the vault archive.
 * Returns the archive basename ("<id>.jsonl") on success, or null if the source
 * transcript no longer exists (e.g. detection never completed, or already purged).
 */
export function archiveTranscript(srcJsonlPath: string, archiveDir: string): string | null {
  if (!fs.existsSync(srcJsonlPath)) return null;
  ensureDir(archiveDir);
  const base = path.basename(srcJsonlPath);
  fs.copyFileSync(srcJsonlPath, path.join(archiveDir, base));
  return base;
}

/**
 * If the live transcript is missing, restore it from the archive so
 * `claude --resume <id>` finds it again. Returns true iff it actually rehydrated.
 */
export function rehydrateIfMissing(archivePath: string, destJsonlPath: string): boolean {
  if (fs.existsSync(destJsonlPath)) return false; // still live — nothing to do
  if (!fs.existsSync(archivePath)) return false;  // no archive to restore from
  ensureDir(path.dirname(destJsonlPath));
  fs.copyFileSync(archivePath, destJsonlPath);
  return true;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object") {
          const block = b as { type?: string; text?: string; name?: string };
          if (block.type === "text") return block.text ?? "";
          if (block.type === "tool_use") return `\n_→ used ${block.name ?? "a tool"}_\n`;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * Render a raw transcript .jsonl into readable markdown (user + assistant turns)
 * for the "Read" action. Pure: takes the file contents, returns markdown.
 */
export function renderTranscriptMarkdown(jsonl: string, title?: string): string {
  const parts: string[] = [];
  if (title) parts.push(`# ${title}\n`);
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let d: { type?: string; message?: { content?: unknown } };
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.type === "user") {
      const t = extractText(d.message?.content).trim();
      if (t) parts.push(`## 👤 User\n\n${t}\n`);
    } else if (d.type === "assistant") {
      const t = extractText(d.message?.content).trim();
      if (t) parts.push(`## ✻ Claude\n\n${t}\n`);
    }
  }
  return parts.join("\n");
}
