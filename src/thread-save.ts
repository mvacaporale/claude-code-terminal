import { Notice, TFile, normalizePath } from "obsidian";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import type ClaudeTerminalPlugin from "./main";
import { ThreadGroup, ThreadRef, transcriptPath, upsertThreadGroup } from "./claude-threads";
import { archiveTranscript, threadsDir } from "./thread-archive";

/**
 * URI query params. Recognized keys: `note` (target path), `group` (group name),
 * `tabs` (comma-separated tab names; omitted = all open tabs). Modeled as a record
 * so Obsidian's ObsidianProtocolData is assignable.
 */
export type SaveParams = Record<string, string | undefined>;

/** Resolve-or-create the target note (with parent folders), mirroring HighlightNoteSync.ensureNoteFile. */
async function ensureNote(plugin: ClaudeTerminalPlugin, notePath: string): Promise<TFile> {
  const p = normalizePath(notePath);
  const existing = plugin.app.vault.getAbstractFileByPath(p);
  if (existing instanceof TFile) return existing;
  const folder = p.split("/").slice(0, -1).join("/");
  if (folder) {
    let cur = "";
    for (const seg of folder.split("/")) {
      cur = cur ? `${cur}/${seg}` : seg;
      await plugin.app.vault.createFolder(cur).catch(() => {});
    }
  }
  return plugin.app.vault.create(p, "");
}

/**
 * Handle obsidian://claude-threads-save?note=&group=&tabs= — snapshot the named
 * open tabs, archive their transcripts into the vault, and upsert the group's
 * block into the note. Writes a receipt the calling agent can read to confirm.
 */
export async function handleSaveThreads(plugin: ClaudeTerminalPlugin, params: SaveParams): Promise<void> {
  const vaultPath = plugin.getVaultPath();
  const archiveDir = threadsDir(vaultPath);
  const group = (params.group ?? "").trim();
  const note = (params.note ?? "").trim();

  const fail = (reason: string) => {
    new Notice(`Save threads failed: ${reason}`);
    writeReceipt(archiveDir, { ok: false, reason, group, note });
  };

  if (!group) return fail("missing group name");
  if (!note) return fail("missing target note");

  const wanted = (params.tabs ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const all = plugin.collectAllThreadRefs();
  const refs = wanted.length ? all.filter((r) => wanted.includes(r.name)) : all;

  if (refs.length === 0) {
    return fail(wanted.length ? `no open tabs match: ${wanted.join(", ")}` : "no open tabs to save");
  }

  // Archive each local thread's transcript; remote transcripts live on the host (skipped for now).
  const home = os.homedir();
  const saved: ThreadRef[] = refs.map((r) => {
    const ref: ThreadRef = { name: r.name, session: r.session, cwd: r.cwd, remote: r.remote ?? null };
    if (!r.remote && r.session) {
      const archived = archiveTranscript(transcriptPath(home, r.cwd, r.session), archiveDir);
      if (archived) ref.archive = archived;
    }
    return ref;
  });

  const groupData: ThreadGroup = { group, threads: saved };
  const file = await ensureNote(plugin, note);
  await plugin.app.vault.process(file, (content) => upsertThreadGroup(content, groupData));

  const archivedCount = saved.filter((t) => t.archive).length;
  writeReceipt(archiveDir, {
    ok: true,
    group,
    note: file.path,
    saved: saved.length,
    archived: archivedCount,
    threads: saved.map((t) => ({ name: t.name, session: t.session, archived: !!t.archive, remote: !!t.remote })),
  });
  new Notice(`Saved ${saved.length} thread${saved.length === 1 ? "" : "s"} to “${group}” in ${file.path}` +
    (archivedCount < saved.length ? ` (${saved.length - archivedCount} not archived)` : ""));
}

function writeReceipt(archiveDir: string, data: Record<string, unknown>): void {
  try {
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(
      path.join(archiveDir, ".last-save.json"),
      JSON.stringify({ ...data, at: new Date().toISOString() }, null, 2)
    );
  } catch {
    /* receipt is best-effort */
  }
}
