import { describe, expect, it } from "vitest";
import { buildSessionBody, initialNoteContent, upsertSessionSection } from "../src/highlight-note-format";

describe("initialNoteContent", () => {
  it("writes tags as a YAML list (Obsidian rejects comma-joined strings)", () => {
    expect(initialNoteContent("2026-07-26")).toContain("tags: [claude-code, terminal]");
  });
});

describe("buildSessionBody", () => {
  it("renders one bullet per highlight, oldest first", () => {
    const body = buildSessionBody([
      { text: "second", timestamp: 2 },
      { text: "first", timestamp: 1 },
    ]);
    expect(body).toBe("- first\n- second");
  });

  it("flattens multi-line highlight text", () => {
    expect(buildSessionBody([{ text: "a\nb\nc", timestamp: 1 }])).toBe("- a b c");
  });

  it("returns an empty string for no highlights", () => {
    expect(buildSessionBody([])).toBe("");
  });
});

describe("upsertSessionSection", () => {
  const doc = `---
type: highlights
---

# Claude Terminal Highlights - 2026-07-26
`;

  it("appends a new section when the heading is absent", () => {
    const out = upsertSessionSection(doc, "## Session 10:00 AM", "- one");
    expect(out).toContain("## Session 10:00 AM\n\n- one\n");
    expect(out.indexOf("## Session")).toBeGreaterThan(out.indexOf("# Claude Terminal"));
  });

  it("appends a bare heading when the body is empty", () => {
    const out = upsertSessionSection(doc, "## Session 10:00 AM", "");
    expect(out.trimEnd().endsWith("## Session 10:00 AM")).toBe(true);
  });

  it("replaces the section body on re-sync (idempotent)", () => {
    let out = upsertSessionSection(doc, "## Session 10:00 AM", "- one");
    out = upsertSessionSection(out, "## Session 10:00 AM", "- one\n- two");
    out = upsertSessionSection(out, "## Session 10:00 AM", "- one\n- two");
    expect(out).toContain("- one\n- two");
    expect(out.match(/- one/g)).toHaveLength(1);
    expect(out.match(/## Session 10:00 AM/g)).toHaveLength(1);
  });

  it("can empty a section after clear-all", () => {
    let out = upsertSessionSection(doc, "## Session 10:00 AM", "- one");
    out = upsertSessionSection(out, "## Session 10:00 AM", "");
    expect(out).not.toContain("- one");
    expect(out).toContain("## Session 10:00 AM");
  });

  it("only rewrites up to the next heading", () => {
    let out = upsertSessionSection(doc, "## Session 09:00 AM", "- old");
    out = upsertSessionSection(out, "## Session 10:00 AM", "- new");
    out = upsertSessionSection(out, "## Session 10:00 AM", "- newer");
    expect(out).toContain("- old");
    expect(out).toContain("- newer");
    expect(out).not.toContain("- new\n");
  });

  it("targets the last occurrence of a duplicated heading", () => {
    const withDupes = `${doc}
## Session 10:00 AM

- frozen

## Session 10:00 AM
`;
    const out = upsertSessionSection(withDupes, "## Session 10:00 AM", "- fresh");
    expect(out).toContain("- frozen");
    expect(out).toContain("- fresh");
    expect(out.indexOf("- fresh")).toBeGreaterThan(out.indexOf("- frozen"));
  });
});
