import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { archiveTranscript, rehydrateIfMissing, renderTranscriptMarkdown } from "../src/thread-archive";

const tmps: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ct-threads-"));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("archiveTranscript", () => {
  it("copies the transcript into the archive dir and returns its basename", () => {
    const root = tmp();
    const src = path.join(root, "projects", "enc", "sid-1.jsonl");
    fs.mkdirSync(path.dirname(src), { recursive: true });
    fs.writeFileSync(src, '{"type":"user"}\n');
    const archiveDir = path.join(root, "vault", ".claude", "threads");

    const base = archiveTranscript(src, archiveDir);

    expect(base).toBe("sid-1.jsonl");
    expect(fs.readFileSync(path.join(archiveDir, "sid-1.jsonl"), "utf8")).toBe('{"type":"user"}\n');
  });

  it("returns null when the source transcript is gone", () => {
    const root = tmp();
    expect(archiveTranscript(path.join(root, "missing.jsonl"), path.join(root, "threads"))).toBeNull();
  });
});

describe("rehydrateIfMissing", () => {
  it("restores the transcript from the archive when the live file is gone", () => {
    const root = tmp();
    const archive = path.join(root, "threads", "sid-2.jsonl");
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    fs.writeFileSync(archive, "ARCHIVED");
    const dest = path.join(root, "projects", "enc", "sid-2.jsonl"); // parent does not exist yet

    expect(rehydrateIfMissing(archive, dest)).toBe(true);
    expect(fs.readFileSync(dest, "utf8")).toBe("ARCHIVED");
  });

  it("does nothing when the live transcript still exists", () => {
    const root = tmp();
    const archive = path.join(root, "threads", "sid-3.jsonl");
    const dest = path.join(root, "dest", "sid-3.jsonl");
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(archive, "ARCHIVED");
    fs.writeFileSync(dest, "LIVE");

    expect(rehydrateIfMissing(archive, dest)).toBe(false);
    expect(fs.readFileSync(dest, "utf8")).toBe("LIVE"); // untouched
  });

  it("returns false when neither live nor archive exists", () => {
    const root = tmp();
    expect(rehydrateIfMissing(path.join(root, "a.jsonl"), path.join(root, "b.jsonl"))).toBe(false);
  });
});

describe("renderTranscriptMarkdown", () => {
  const jsonl = [
    JSON.stringify({ type: "mode", mode: "default" }),
    JSON.stringify({ type: "user", message: { content: "hello there" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi!" }, { type: "tool_use", name: "Bash" }] } }),
    JSON.stringify({ type: "ai-title", aiTitle: "x" }),
    "not json",
  ].join("\n");

  it("renders user + assistant turns and skips noise/non-JSON", () => {
    const md = renderTranscriptMarkdown(jsonl, "My Thread");
    expect(md).toContain("# My Thread");
    expect(md).toContain("## 👤 User");
    expect(md).toContain("hello there");
    expect(md).toContain("## ✻ Claude");
    expect(md).toContain("hi!");
    expect(md).toContain("used Bash");
    expect(md).not.toContain('"type":"mode"'); // noise dropped
  });
});
