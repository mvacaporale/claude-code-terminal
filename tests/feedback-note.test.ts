import { describe, it, expect } from "vitest";
import { formatBacklogBullet, appendToBacklogSection } from "../src/feedback-note";

describe("formatBacklogBullet", () => {
  it("matches the backlog capture style", () => {
    expect(formatBacklogBullet("Add dark mode", [], "2026-08-21")).toBe(
      "- [ ] **Add dark mode** *(captured 2026-08-21 — via terminal feedback)*"
    );
  });

  it("collapses newlines in the message to a single line", () => {
    expect(formatBacklogBullet("line one\n  line two", [], "2026-08-21")).toBe(
      "- [ ] **line one line two** *(captured 2026-08-21 — via terminal feedback)*"
    );
  });

  it("adds screenshot embeds on an indented continuation line", () => {
    expect(formatBacklogBullet("bug", ["shot-1.png", "shot-2.png"], "2026-08-21")).toBe(
      "- [ ] **bug** *(captured 2026-08-21 — via terminal feedback)*\n\t- screenshots: ![[shot-1.png]] ![[shot-2.png]]"
    );
  });
});

describe("appendToBacklogSection", () => {
  const bullet = "- [ ] **new idea** *(captured 2026-08-21 — via terminal feedback)*";

  it("appends at the end of the Ideas / Backlog section, before the next ## heading", () => {
    const content = [
      "# Code",
      "",
      "## Ideas / Backlog",
      "",
      "- [ ] existing one",
      "",
      "## Projects",
      "",
      "- something",
      "",
    ].join("\n");
    const out = appendToBacklogSection(content, bullet);
    const lines = out.split("\n");
    expect(lines.indexOf(bullet)).toBeGreaterThan(lines.indexOf("- [ ] existing one"));
    expect(lines.indexOf(bullet)).toBeLessThan(lines.indexOf("## Projects"));
  });

  it("keeps the item inside the section when it ends with ### subheadings at EOF", () => {
    const content = [
      "## Ideas / Backlog",
      "",
      "- [ ] first",
      "",
      "### Captured from voice memos",
      "- [ ] second",
      "",
    ].join("\n");
    const out = appendToBacklogSection(content, bullet);
    // Bullet lands after the last non-blank line, still under the ## section.
    expect(out).toContain("- [ ] second\n" + bullet);
  });

  it("creates the section when the heading is missing", () => {
    const out = appendToBacklogSection("# Code\n\nSome intro.\n", bullet);
    expect(out).toBe("# Code\n\nSome intro.\n\n## Ideas / Backlog\n\n" + bullet + "\n");
  });

  it("creates the section from empty content", () => {
    expect(appendToBacklogSection("", bullet)).toBe("## Ideas / Backlog\n\n" + bullet + "\n");
  });
});
