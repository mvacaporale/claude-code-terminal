import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import {
  SKILL_MD,
  installSkill,
  parseFeedback,
  parseNewTab,
  skillPath,
  tokenMatches,
  writeLinkReceipt,
} from "../src/agent-links";

const TOKEN = "0123456789abcdef0123456789abcdef";

describe("tokenMatches", () => {
  it("accepts only the exact token", () => {
    expect(tokenMatches({ token: TOKEN }, TOKEN)).toBe(true);
    expect(tokenMatches({ token: TOKEN.slice(0, -1) + "0" }, TOKEN)).toBe(false);
    expect(tokenMatches({}, TOKEN)).toBe(false);
  });

  it("never matches when the install has no token yet", () => {
    expect(tokenMatches({ token: "" }, "")).toBe(false);
  });
});

describe("parseNewTab", () => {
  it("returns the trimmed prompt and optional name", () => {
    expect(parseNewTab({ token: TOKEN, prompt: "  do it ", name: " Job " }, TOKEN))
      .toEqual({ ok: true, value: { prompt: "do it", name: "Job" } });
    expect(parseNewTab({ token: TOKEN, prompt: "do it" }, TOKEN))
      .toEqual({ ok: true, value: { prompt: "do it" } });
  });

  it("rejects a link without the token, or without a prompt", () => {
    expect(parseNewTab({ prompt: "rm -rf" }, TOKEN)).toEqual({ ok: false, reason: "missing or wrong token" });
    expect(parseNewTab({ token: TOKEN, prompt: " " }, TOKEN)).toEqual({ ok: false, reason: "missing prompt" });
  });
});

describe("parseFeedback", () => {
  it("needs the token and some text", () => {
    expect(parseFeedback({ token: TOKEN, text: "Bug\nDetails" }, TOKEN))
      .toEqual({ ok: true, value: { text: "Bug\nDetails" } });
    expect(parseFeedback({ text: "Bug" }, TOKEN).ok).toBe(false);
    expect(parseFeedback({ token: TOKEN }, TOKEN)).toEqual({ ok: false, reason: "missing text" });
  });
});

describe("installSkill", () => {
  it("writes the skill once and rewrites it only when changed", () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
    expect(installSkill(vault)).toBe(true);
    expect(fs.readFileSync(skillPath(vault), "utf8")).toBe(SKILL_MD);
    expect(installSkill(vault)).toBe(false);
    fs.writeFileSync(skillPath(vault), "stale");
    expect(installSkill(vault)).toBe(true);
    expect(fs.readFileSync(skillPath(vault), "utf8")).toBe(SKILL_MD);
  });
});

describe("writeLinkReceipt", () => {
  it("writes JSON with a timestamp", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rcpt-")), "r.json");
    writeLinkReceipt(file, { ok: true }, new Date("2026-10-30T00:00:00Z"));
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ ok: true, at: "2026-10-30T00:00:00.000Z" });
  });
});

describe("skill's link command", () => {
  it("builds a correctly encoded obsidian:// URL", () => {
    // Run the skill's python one-liner with `open` swapped for echo.
    const cmd = SKILL_MD.match(/(python3 -c '.*?') claude-new-tab/)![1];
    const script = cmd.slice("python3 -c '".length, -1).replace('["open", ', '["echo", ');
    const out = execFileSync("python3", ["-c", script, "claude-new-tab", "name=My tab", "prompt=a&b=c\nline 2"], {
      env: { ...process.env, CLAUDE_TERMINAL_TOKEN: TOKEN },
    }).toString().trim();
    expect(out).not.toContain("+");
    const url = new URL(out);
    expect(url.protocol).toBe("obsidian:");
    expect(url.searchParams.get("token")).toBe(TOKEN);
    expect(url.searchParams.get("name")).toBe("My tab");
    expect(url.searchParams.get("prompt")).toBe("a&b=c\nline 2");
  });
});
