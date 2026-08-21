/**
 * Pure formatting/insertion logic for routing in-UI feedback into the Code
 * backlog note (the file the product-triage job reads). Kept free of Obsidian
 * and Electron imports so it can be unit-tested directly.
 */

export const DEFAULT_BACKLOG_HEADING = "## Ideas / Backlog";

/**
 * Render one backlog bullet in the existing capture style:
 *   - [ ] **<message>** *(captured <date> — via terminal feedback)*
 * Screenshots (if any) go on an indented continuation line as embeds.
 */
export function formatBacklogBullet(message: string, screenshotFiles: string[], dateStr: string): string {
  const text = message.trim().replace(/\s*\n\s*/g, " ");
  let bullet = `- [ ] **${text}** *(captured ${dateStr} — via terminal feedback)*`;
  if (screenshotFiles.length > 0) {
    const embeds = screenshotFiles.map((f) => `![[${f}]]`).join(" ");
    bullet += `\n\t- screenshots: ${embeds}`;
  }
  return bullet;
}

/**
 * Insert `bullet` at the end of the `heading` section — just before the next
 * top-level `##` heading, or at end-of-file if the section runs to the end.
 * `###` subheadings are not section boundaries, so the item stays inside the
 * backlog. If the heading is absent, the section is created at end-of-file.
 */
export function appendToBacklogSection(content: string, bullet: string, heading = DEFAULT_BACKLOG_HEADING): string {
  const lines = content.split("\n");
  const headingIdx = lines.findIndex((l) => l.trim() === heading);

  if (headingIdx === -1) {
    const base = content.replace(/\s*$/, "");
    const lead = base.length > 0 ? `${base}\n\n` : "";
    return `${lead}${heading}\n\n${bullet}\n`;
  }

  let endIdx = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }

  // Insert after the last non-blank line of the section (before trailing blanks).
  let insertAt = endIdx;
  while (insertAt > headingIdx + 1 && lines[insertAt - 1].trim() === "") insertAt--;
  lines.splice(insertAt, 0, bullet);
  return lines.join("\n");
}

/** Minimal vault surface persistFeedback needs — adapted from Obsidian's vault in main.ts. */
export interface FeedbackVaultDeps {
  readFileIfExists(path: string): Promise<string | null>;
  writeFile(path: string, data: string): Promise<void>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  ensureFolder(path: string): Promise<void>;
}

export interface FeedbackInput {
  message: string;
  screenshots: Uint8Array[];
  dateStr: string;
  /** Milliseconds stamp used to name screenshot files (kept injectable for tests). */
  stamp: number;
  notePath: string;
  heading?: string;
}

/**
 * Write any screenshots into a `_feedback-shots` folder beside the note, then
 * append a capture bullet under the note's backlog heading. All I/O goes
 * through the injected deps so the routing logic is unit-testable.
 */
export async function persistFeedback(deps: FeedbackVaultDeps, input: FeedbackInput): Promise<void> {
  const { message, screenshots, dateStr, stamp, notePath, heading = DEFAULT_BACKLOG_HEADING } = input;

  const embeds: string[] = [];
  if (screenshots.length > 0) {
    const parent = notePath.includes("/") ? notePath.slice(0, notePath.lastIndexOf("/")) : "";
    const shotsDir = `${parent ? parent + "/" : ""}_feedback-shots`;
    await deps.ensureFolder(shotsDir);
    for (let i = 0; i < screenshots.length; i++) {
      const name = `feedback-${stamp}-${i + 1}.png`;
      const bytes = screenshots[i];
      const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      await deps.writeBinary(`${shotsDir}/${name}`, buf);
      embeds.push(name); // basename; Obsidian resolves the embed
    }
  }

  const bullet = formatBacklogBullet(message, embeds, dateStr);
  const existing = await deps.readFileIfExists(notePath);
  await deps.writeFile(notePath, appendToBacklogSection(existing ?? "", bullet, heading));
}
