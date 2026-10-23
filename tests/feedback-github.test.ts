import { describe, it, expect } from "vitest";
import {
  feedbackBody,
  feedbackTitle,
  fileFeedbackIssue,
  isFeedbackConfigured,
  HttpFn,
  HttpRequest,
} from "../src/feedback-github";

const meta = { pluginVersion: "1.2.0", vaultName: "Lodestone", platform: "darwin", dateStr: "2026-10-23" };
const target = { repo: "mvacaporale/claude-code-terminal-feedback", token: "tok" };

/** Fake GitHub API at the HTTP boundary; records every request. */
function fakeGitHub(overrides: Partial<Record<"PUT" | "POST", { status: number; json: any }>> = {}) {
  const calls: HttpRequest[] = [];
  const http: HttpFn = async (req) => {
    calls.push(req);
    if (overrides[req.method]) return overrides[req.method]!;
    if (req.method === "PUT") {
      const path = req.url.split("/contents/")[1];
      return { status: 201, json: { content: { html_url: `https://github.com/${target.repo}/blob/main/${path}` } } };
    }
    return { status: 201, json: { number: 7, html_url: `https://github.com/${target.repo}/issues/7` } };
  };
  return { http, calls };
}

describe("isFeedbackConfigured", () => {
  it("needs an owner/name repo and a token", () => {
    expect(isFeedbackConfigured(target)).toBe(true);
    expect(isFeedbackConfigured({ repo: "", token: "tok" })).toBe(false);
    expect(isFeedbackConfigured({ repo: "just-a-name", token: "tok" })).toBe(false);
    expect(isFeedbackConfigured({ repo: target.repo, token: " " })).toBe(false);
  });
});

describe("feedbackTitle", () => {
  it("uses the first line and truncates long ones", () => {
    expect(feedbackTitle("  tabs flicker\nwhen resizing")).toBe("tabs flicker");
    const t = feedbackTitle("x".repeat(100));
    expect(t.length).toBe(72);
    expect(t.endsWith("…")).toBe(true);
  });
});

describe("feedbackBody", () => {
  it("includes message, screenshots and a source footer", () => {
    const body = feedbackBody("broken thing", ["https://x/a.png?raw=true"], meta);
    expect(body).toContain("broken thing");
    expect(body).toContain("![screenshot 1](https://x/a.png?raw=true)");
    expect(body).toContain("claude-code-terminal v1.2.0 · vault `Lodestone` · darwin · 2026-10-23");
  });
});

describe("fileFeedbackIssue", () => {
  it("opens a labelled issue with the token", async () => {
    const gh = fakeGitHub();
    const out = await fileFeedbackIssue(gh.http, target, { message: "add a shortcut", screenshots: [], stamp: 1, meta });
    expect(out).toEqual({ number: 7, url: `https://github.com/${target.repo}/issues/7` });
    expect(gh.calls).toHaveLength(1);
    const [req] = gh.calls;
    expect(req.url).toBe(`https://api.github.com/repos/${target.repo}/issues`);
    expect(req.headers.Authorization).toBe("Bearer tok");
    const payload = JSON.parse(req.body);
    expect(payload.title).toBe("add a shortcut");
    expect(payload.labels).toEqual(["feedback", "claude-code-terminal"]);
  });

  it("commits screenshots first and embeds them", async () => {
    const gh = fakeGitHub();
    await fileFeedbackIssue(gh.http, target, {
      message: "look",
      screenshots: [new Uint8Array([1, 2, 3]), new Uint8Array([4])],
      stamp: 99,
      meta,
    });
    expect(gh.calls.map((c) => c.method)).toEqual(["PUT", "PUT", "POST"]);
    expect(gh.calls[0].url).toContain("/contents/screenshots/claude-code-terminal/99-1.png");
    expect(JSON.parse(gh.calls[0].body).content).toBe(Buffer.from([1, 2, 3]).toString("base64"));
    const body = JSON.parse(gh.calls[2].body).body;
    expect(body).toContain("screenshots/claude-code-terminal/99-2.png?raw=true");
  });

  it("surfaces GitHub's error message", async () => {
    const gh = fakeGitHub({ POST: { status: 404, json: { message: "Not Found" } } });
    await expect(
      fileFeedbackIssue(gh.http, target, { message: "x", screenshots: [], stamp: 1, meta })
    ).rejects.toThrow("GitHub issue create failed (404: Not Found)");
  });
});
