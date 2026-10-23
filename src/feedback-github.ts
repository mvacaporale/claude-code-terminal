/**
 * Files in-UI feedback as a GitHub issue in a repo the owner controls
 * (a private companion repo, since this plugin's own repo is a public fork).
 * Only an install holding a token with write access to that repo can file,
 * so other people running the plugin can't reach the inbox. Kept free of
 * Obsidian imports so it can be unit-tested; main.ts injects `requestUrl`.
 */

export const FEEDBACK_LABEL = "feedback";
export const FEEDBACK_SOURCE = "claude-code-terminal";
const TITLE_MAX = 72;

export interface HttpRequest {
  url: string;
  method: "POST" | "PUT";
  headers: Record<string, string>;
  body: string;
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

/**
 * Commit each screenshot under `screenshots/<source>/`, then open one issue
 * labelled `feedback` + the source tool. Returns the new issue's number/URL.
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
  for (let i = 0; i < input.screenshots.length; i++) {
    const path = `screenshots/${FEEDBACK_SOURCE}/${input.stamp}-${i + 1}.png`;
    const res = await http({
      url: `${api}/contents/${path}`,
      method: "PUT",
      headers: h,
      body: JSON.stringify({
        message: `Feedback screenshot ${input.stamp}-${i + 1}`,
        content: Buffer.from(input.screenshots[i]).toString("base64"),
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
      labels: [FEEDBACK_LABEL, FEEDBACK_SOURCE],
    }),
  });
  if (res.status !== 201) throw apiError("issue create", res);
  return { number: res.json.number, url: res.json.html_url };
}
