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
const target = { repo: "mvacaporale/claude-code-terminal", token: "tok" };

/** Fake GitHub API at the HTTP boundary; records every request. */
function fakeGitHub(
  overrides: Partial<Record<"PUT" | "POST", { status: number; json: any }>> = {},
  { branchExists = true } = {}
) {
  const calls: HttpRequest[] = [];
  const api = `https://api.github.com/repos/${target.repo}`;
  const http: HttpFn = async (req) => {
    calls.push(req);
    if (req.method === "GET") {
      if (req.url === api) return { status: 200, json: { default_branch: "main" } };
      if (req.url.endsWith("/heads/main")) return { status: 200, json: { object: { sha: "abc" } } };
      return branchExists ? { status: 200, json: {} } : { status: 404, json: { message: "Not Found" } };
    }
    if (req.url.endsWith("/git/refs")) return { status: 201, json: {} };
    if (overrides[req.method]) return overrides[req.method]!;
    if (req.method === "PUT") {
      const path = req.url.split("/contents/")[1];
      const branch = JSON.parse(req.body!).branch;
      return { status: 201, json: { content: { html_url: `https://github.com/${target.repo}/blob/${branch}/${path}` } } };
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
    const payload = JSON.parse(req.body!);
    expect(payload.title).toBe("add a shortcut");
    expect(payload.labels).toEqual(["feedback"]);
  });

  it("commits screenshots to the side branch first and embeds them", async () => {
    const gh = fakeGitHub();
    await fileFeedbackIssue(gh.http, target, {
      message: "look",
      screenshots: [new Uint8Array([1, 2, 3]), new Uint8Array([4])],
      stamp: 99,
      meta,
    });
    expect(gh.calls.map((c) => c.method)).toEqual(["GET", "PUT", "PUT", "POST"]);
    expect(gh.calls[1].url).toContain("/contents/screenshots/99-1.png");
    const put = JSON.parse(gh.calls[1].body!);
    expect(put.content).toBe(Buffer.from([1, 2, 3]).toString("base64"));
    expect(put.branch).toBe("feedback-screenshots");
    const body = JSON.parse(gh.calls[3].body!).body;
    expect(body).toContain("blob/feedback-screenshots/screenshots/99-2.png?raw=true");
  });

  it("creates the screenshot branch from the default branch when missing", async () => {
    const gh = fakeGitHub({}, { branchExists: false });
    await fileFeedbackIssue(gh.http, target, { message: "x", screenshots: [new Uint8Array([1])], stamp: 1, meta });
    const create = gh.calls.find((c) => c.url.endsWith("/git/refs"))!;
    expect(JSON.parse(create.body!)).toEqual({ ref: "refs/heads/feedback-screenshots", sha: "abc" });
  });

  it("skips branch calls when there are no screenshots", async () => {
    const gh = fakeGitHub({}, { branchExists: false });
    await fileFeedbackIssue(gh.http, target, { message: "x", screenshots: [], stamp: 1, meta });
    expect(gh.calls.map((c) => c.method)).toEqual(["POST"]);
  });

  it("surfaces GitHub's error message", async () => {
    const gh = fakeGitHub({ POST: { status: 404, json: { message: "Not Found" } } });
    await expect(
      fileFeedbackIssue(gh.http, target, { message: "x", screenshots: [], stamp: 1, meta })
    ).rejects.toThrow("GitHub issue create failed (404: Not Found)");
  });
});
