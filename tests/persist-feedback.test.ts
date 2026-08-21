import { describe, it, expect } from "vitest";
import { persistFeedback, FeedbackVaultDeps } from "../src/feedback-note";

/** In-memory vault standing in for Obsidian's vault at the deps boundary. */
function fakeVault(seed: Record<string, string> = {}) {
  const files: Record<string, string> = { ...seed };
  const binaries: Record<string, number> = {};
  const folders: string[] = [];
  const deps: FeedbackVaultDeps = {
    readFileIfExists: async (p) => (p in files ? files[p] : null),
    writeFile: async (p, data) => {
      files[p] = data;
    },
    writeBinary: async (p, data) => {
      binaries[p] = data.byteLength;
    },
    ensureFolder: async (p) => {
      if (!folders.includes(p)) folders.push(p);
    },
  };
  return { deps, files, binaries, folders };
}

const png = (n: number) => new Uint8Array(n).fill(1);

describe("persistFeedback", () => {
  it("appends a bullet into an existing note's backlog section", async () => {
    const v = fakeVault({
      "5. Code/_index.md": "# Code\n\n## Ideas / Backlog\n\n- [ ] old idea\n",
    });
    await persistFeedback(v.deps, {
      message: "add a keyboard shortcut",
      screenshots: [],
      dateStr: "2026-08-21",
      stamp: 1000,
      notePath: "5. Code/_index.md",
    });
    const out = v.files["5. Code/_index.md"];
    expect(out).toContain("- [ ] old idea");
    expect(out).toContain("- [ ] **add a keyboard shortcut** *(captured 2026-08-21 — via terminal feedback)*");
    expect(Object.keys(v.binaries)).toHaveLength(0);
  });

  it("writes screenshots beside the note and embeds them by basename", async () => {
    const v = fakeVault({ "5. Code/_index.md": "## Ideas / Backlog\n" });
    await persistFeedback(v.deps, {
      message: "layout bug",
      screenshots: [png(10), png(20)],
      dateStr: "2026-08-21",
      stamp: 42,
      notePath: "5. Code/_index.md",
    });
    expect(v.folders).toContain("5. Code/_feedback-shots");
    expect(v.binaries["5. Code/_feedback-shots/feedback-42-1.png"]).toBe(10);
    expect(v.binaries["5. Code/_feedback-shots/feedback-42-2.png"]).toBe(20);
    expect(v.files["5. Code/_index.md"]).toContain(
      "- screenshots: ![[feedback-42-1.png]] ![[feedback-42-2.png]]"
    );
  });

  it("creates the note (and section) when it doesn't exist yet", async () => {
    const v = fakeVault();
    await persistFeedback(v.deps, {
      message: "first ever idea",
      screenshots: [],
      dateStr: "2026-08-21",
      stamp: 1,
      notePath: "Backlog.md",
    });
    expect(v.files["Backlog.md"]).toBe(
      "## Ideas / Backlog\n\n- [ ] **first ever idea** *(captured 2026-08-21 — via terminal feedback)*\n"
    );
  });

  it("puts screenshots in the vault root when the note has no parent folder", async () => {
    const v = fakeVault({ "Backlog.md": "## Ideas / Backlog\n" });
    await persistFeedback(v.deps, {
      message: "x",
      screenshots: [png(5)],
      dateStr: "2026-08-21",
      stamp: 7,
      notePath: "Backlog.md",
    });
    expect(v.folders).toContain("_feedback-shots");
    expect(v.binaries["_feedback-shots/feedback-7-1.png"]).toBe(5);
  });
});
