import { describe, expect, it } from "vitest";
import {
  encodeProjectDir,
  transcriptPath,
  serializeThreadGroup,
  parseThreadGroup,
  buildThreadBlock,
  upsertThreadGroup,
  parseAllThreadGroups,
  resumeTarget,
  type ThreadGroup,
} from "../src/claude-threads";

describe("encodeProjectDir", () => {
  it("maps every non-alphanumeric char to '-' (the '. ' in a folder name becomes '--')", () => {
    expect(encodeProjectDir("/Users/mc/Documents/Resources/Lodestone/5. Code")).toBe(
      "-Users-mc-Documents-Resources-Lodestone-5--Code"
    );
  });
  it("handles a plain path", () => {
    expect(encodeProjectDir("/tmp/proj")).toBe("-tmp-proj");
  });
});

describe("transcriptPath", () => {
  it("builds ~/.claude/projects/<enc>/<id>.jsonl", () => {
    expect(transcriptPath("/home/mc", "/tmp/proj", "abc-123")).toBe(
      "/home/mc/.claude/projects/-tmp-proj/abc-123.jsonl"
    );
  });
});

const sample: ThreadGroup = {
  group: "Research",
  threads: [
    { name: "Bioelectricity survey", session: "51e17625-abc", cwd: "/v", archive: "51e17625-abc.jsonl" },
    { name: "Planaria: regen", session: null, cwd: "/v", remote: { host: "miciato", path: "/root", tmuxName: "obs-x" } },
  ],
};

describe("serialize/parse round-trip", () => {
  it("round-trips a group, preserving special chars in names", () => {
    expect(parseThreadGroup(serializeThreadGroup(sample))).toEqual(sample);
  });
  it("returns null for non-JSON and for wrong shape", () => {
    expect(parseThreadGroup("not json")).toBeNull();
    expect(parseThreadGroup(JSON.stringify({ group: "x" }))).toBeNull();
    expect(parseThreadGroup(JSON.stringify({ threads: [] }))).toBeNull();
  });
});

describe("upsertThreadGroup", () => {
  it("appends a block to empty content", () => {
    const out = upsertThreadGroup("", sample);
    expect(out).toBe(buildThreadBlock(sample) + "\n");
    expect(parseAllThreadGroups(out)).toEqual([sample]);
  });

  it("appends after existing note text with one blank line", () => {
    const note = "# Levin\n\nSome prose about morphogenesis.\n";
    const out = upsertThreadGroup(note, sample);
    expect(out.startsWith(note)).toBe(true);
    expect(out).toContain("```claude-threads");
    expect(parseAllThreadGroups(out)).toEqual([sample]);
  });

  it("replaces only the matching group, leaving other groups and prose intact", () => {
    const other: ThreadGroup = { group: "Drafting", threads: [{ name: "Outline", session: "s1", cwd: "/v" }] };
    let note = "# Levin\n\nProse.\n";
    note = upsertThreadGroup(note, sample);   // Research
    note = upsertThreadGroup(note, other);    // Drafting
    expect(parseAllThreadGroups(note).map(g => g.group)).toEqual(["Research", "Drafting"]);

    const updated: ThreadGroup = { group: "Research", threads: [{ name: "New only", session: "s9", cwd: "/v" }] };
    const out = upsertThreadGroup(note, updated);

    const groups = parseAllThreadGroups(out);
    expect(groups.map(g => g.group)).toEqual(["Research", "Drafting"]); // order + count preserved
    expect(groups[0].threads).toEqual(updated.threads);                 // Research body replaced
    expect(groups[1].threads).toEqual(other.threads);                   // Drafting untouched
    expect(out).toContain("# Levin");                                   // prose untouched
    expect(out).toContain("Prose.");
  });
});

describe("resumeTarget", () => {
  const local = { name: "Sleep Tracking", session: "1129ac8c", cwd: "/tmp/proj" };
  const expected = "/home/mc/.claude/projects/-tmp-proj/1129ac8c.jsonl";

  it("resumes the block's session id when its transcript exists", () => {
    expect(resumeTarget(local, "/home/mc", p => p === expected)).toBe("1129ac8c");
  });

  it("starts fresh when the transcript is missing", () => {
    expect(resumeTarget(local, "/home/mc", () => false)).toBeNull();
  });

  it("starts fresh when no session id was saved", () => {
    expect(resumeTarget({ ...local, session: null }, "/home/mc", () => true)).toBeNull();
  });

  it("trusts remote ids, whose transcripts live on the remote host", () => {
    const remote = { ...local, remote: { host: "miciato", path: "/root/vault", tmuxName: "t" } };
    expect(resumeTarget(remote, "/home/mc", () => false)).toBe("1129ac8c");
  });
});
