/**
 * Files in-UI feedback as a GitHub issue in the plugin's own (private) repo.
 * Only an install holding a token with write access to that repo can file.
 * Screenshots go on a side branch so main, which the Mac auto-pulls, stays
 * clean. Kept free of Obsidian imports so it can be unit-tested; main.ts
 * injects `requestUrl`.
 */

export const FEEDBACK_LABEL = "feedback";
export const FEEDBACK_SOURCE = "claude-code-terminal";
export const SCREENSHOT_BRANCH = "feedback-screenshots";
const TITLE_MAX = 72;

export interface HttpRequest {
  url: string;
  method: "GET" | "POST" | "PUT";
  headers: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  json: any;
}

export type HttpFn = (req: HttpRequest) => Promise<HttpResponse>;

export interface FeedbackTarget {
  /** "owner/name" of the inbox repo. */
  repo: string;
  /** Fine-grained PAT with Issues + Contents write on `repo` only. */
  token: string;
}

export interface FeedbackMeta {
  pluginVersion: string;
  vaultName: string;
  platform: string;
  dateStr: string;
}

export interface FiledFeedback {
  number: number;
  url: string;
}

export function isFeedbackConfigured(t: FeedbackTarget): boolean {
  return /^[\w.-]+\/[\w.-]+$/.test(t.repo.trim()) && t.token.trim().length > 0;
}

/** First line of the message, trimmed to a readable issue title. */
export function feedbackTitle(message: string): string {
  const first = message.trim().split("\n")[0].trim();
  return first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX - 1).trimEnd()}…` : first;
}

export function feedbackBody(message: string, screenshotUrls: string[], meta: FeedbackMeta): string {
  const parts = [message.trim()];
  if (screenshotUrls.length > 0) {
    parts.push(screenshotUrls.map((u, i) => `![screenshot ${i + 1}](${u})`).join("\n"));
  }
  parts.push(
    `---\n_Source: ${FEEDBACK_SOURCE} v${meta.pluginVersion} · vault \`${meta.vaultName}\` · ${meta.platform} · ${meta.dateStr}_`
  );
  return parts.join("\n\n");
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token.trim()}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

function apiError(what: string, res: HttpResponse): Error {
  const detail = res.json?.message ? `: ${res.json.message}` : "";
  return new Error(`GitHub ${what} failed (${res.status}${detail})`);
}

/** Create the screenshot branch from the default branch's head if it doesn't exist yet. */
async function ensureScreenshotBranch(http: HttpFn, api: string, h: Record<string, string>): Promise<void> {
  const ref = await http({ url: `${api}/git/ref/heads/${SCREENSHOT_BRANCH}`, method: "GET", headers: h });
  if (ref.status === 200) return;
  if (ref.status !== 404) throw apiError("branch lookup", ref);
  const repo = await http({ url: api, method: "GET", headers: h });
  if (repo.status !== 200) throw apiError("repo lookup", repo);
  const base = await http({ url: `${api}/git/ref/heads/${repo.json.default_branch}`, method: "GET", headers: h });
  if (base.status !== 200) throw apiError("branch lookup", base);
  const made = await http({
    url: `${api}/git/refs`,
    method: "POST",
    headers: h,
    body: JSON.stringify({ ref: `refs/heads/${SCREENSHOT_BRANCH}`, sha: base.json.object.sha }),
  });
  // 422 = created concurrently by another submit; fine.
  if (made.status !== 201 && made.status !== 422) throw apiError("branch create", made);
}

/**
 * Commit each screenshot to the screenshot branch, then open one issue
 * labelled `feedback`. Returns the new issue's number/URL.
 */
export async function fileFeedbackIssue(
  http: HttpFn,
  target: FeedbackTarget,
  input: { message: string; screenshots: Uint8Array[]; stamp: number; meta: FeedbackMeta }
): Promise<FiledFeedback> {
  const repo = target.repo.trim();
  const api = `https://api.github.com/repos/${repo}`;
  const h = headers(target.token);

  const shotUrls: string[] = [];
  if (input.screenshots.length > 0) await ensureScreenshotBranch(http, api, h);
  for (let i = 0; i < input.screenshots.length; i++) {
    const path = `screenshots/${input.stamp}-${i + 1}.png`;
    const res = await http({
      url: `${api}/contents/${path}`,
      method: "PUT",
      headers: h,
      body: JSON.stringify({
        message: `Feedback screenshot ${input.stamp}-${i + 1}`,
        content: Buffer.from(input.screenshots[i]).toString("base64"),
        branch: SCREENSHOT_BRANCH,
      }),
    });
    if (res.status !== 201 && res.status !== 200) throw apiError("screenshot upload", res);
    // Blob URL + ?raw=true renders inline in a private repo for signed-in viewers.
    shotUrls.push(`${res.json.content.html_url}?raw=true`);
  }

  const res = await http({
    url: `${api}/issues`,
    method: "POST",
    headers: h,
    body: JSON.stringify({
      title: feedbackTitle(input.message),
      body: feedbackBody(input.message, shotUrls, input.meta),
      labels: [FEEDBACK_LABEL],
    }),
  });
  if (res.status !== 201) throw apiError("issue create", res);
  return { number: res.json.number, url: res.json.html_url };
}
