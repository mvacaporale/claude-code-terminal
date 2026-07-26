/**
 * Pure markdown formatting for the live highlight note — kept free of
 * obsidian imports so it stays unit-testable outside the app.
 */

/** One markdown bullet per highlight, oldest first (newlines flattened). */
export function buildSessionBody(highlights: { text: string; timestamp: number }[]): string {
  return [...highlights]
    .sort((a, b) => a.timestamp - b.timestamp)
    .map(h => `- ${h.text.replace(/\n/g, " ").trim()}`)
    .join("\n");
}

/**
 * Replace the body of the last occurrence of `heading` (up to the next
 * h1/h2 heading or EOF); append a new section when the heading is absent.
 */
export function upsertSessionSection(content: string, heading: string, body: string): string {
  const lines = content.split("\n");
  const bodyLines = body.length > 0 ? body.split("\n") : [];

  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === heading) {
      start = i;
      break;
    }
  }

  if (start === -1) {
    const head = content.trimEnd();
    return (
      (head.length > 0 ? head + "\n\n" : "") +
      heading +
      "\n" +
      (bodyLines.length ? "\n" + bodyLines.join("\n") + "\n" : "")
    );
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,2} /.test(lines[i])) {
      end = i;
      break;
    }
  }

  const parts = [...lines.slice(0, start + 1), ""];
  if (bodyLines.length) parts.push(...bodyLines, "");
  parts.push(...lines.slice(end));
  let out = parts.join("\n");
  if (end === lines.length) out = out.trimEnd() + "\n";
  return out;
}

export function initialNoteContent(dateStr: string): string {
  return `---
type: highlights
tags: [claude-code, terminal]
last_edited: ${dateStr}
summary: Highlights from Claude Code terminal session
---

# Claude Terminal Highlights - ${dateStr}
`;
}
