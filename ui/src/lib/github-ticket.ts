/**
 * Server-only GitHub issue creation for the Provide Feedback dialog.
 * Uses a service token (GITHUB_TICKET_TOKEN or GITHUB_TOKEN) — never the user's OAuth token.
 */

import { randomUUID } from "crypto";

import { Octokit } from "@octokit/rest";

import type { FeedbackContext } from "@/lib/ticket-client";

export type TicketReportSource = "header" | "chat-feedback";

export interface GitHubTicketInput {
  description: string;
  userEmail: string;
  contextUrl: string;
  source: TicketReportSource;
  label: string;
  feedbackContext?: FeedbackContext;
  /** Optional product area selected in the Provide Feedback dialog. */
  area?: string;
  /** Issue type selected in the Provide Feedback dialog. */
  issueType?: "Bug" | "Enhancement";
  /** Base64 data URL of a screenshot, if the user captured one. */
  screenshotDataUrl?: string;
  /**
   * Raw-content URL of the screenshot after it's been uploaded to the
   * screenshots repo (see uploadScreenshotToGitHub). When set, this is
   * embedded as a real inline image instead of the "not embedded" note.
   */
  screenshotUrl?: string;
}

export interface GitHubTicketResult {
  id: string;
  url: string;
  number: number;
  provider: "github";
}

export function parseGitHubRepo(repo: string): { owner: string; repo: string } {
  const trimmed = repo.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    throw new Error(`Invalid GITHUB_TICKET_REPO: "${repo}" (expected owner/repo)`);
  }
  return { owner: trimmed.slice(0, slash), repo: trimmed.slice(slash + 1) };
}

function truncate(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

export function titleFor(input: GitHubTicketInput): string {
  const prefix = "[Platform Report]";
  const areaTag = input.area ? `[${input.area}]` : null;
  const typeTag = input.issueType ? `[${input.issueType}]` : null;
  const reasonTag = input.feedbackContext?.reason;
  const summary = truncate(
    input.description.replace(/\s+/g, " "),
    72,
  );
  const tags = [areaTag, typeTag, reasonTag].filter(Boolean).join(" ");
  return truncate(tags ? `${prefix} ${tags}: ${summary}` : `${prefix} ${summary}`, 240);
}

export function buildGitHubIssueBody(input: GitHubTicketInput): string {
  const lines: string[] = [];

  lines.push("## Summary", "", input.description.trim(), "");

  if (input.area) {
    lines.push("## Area", "", input.area, "");
  }
  if (input.issueType) {
    lines.push("## Issue Type", "", input.issueType, "");
  }

  if (input.feedbackContext) {
    lines.push(
      "## Chat feedback",
      "",
      `- Type: ${input.feedbackContext.feedbackType}`,
      `- Reason: ${input.feedbackContext.reason}`,
    );
    if (input.feedbackContext.additionalFeedback) {
      lines.push(`- Details: ${input.feedbackContext.additionalFeedback}`);
    }
    lines.push("");
  }

  lines.push(
    "## Reporter",
    "",
    `- Email: ${input.userEmail}`,
    `- Context URL: ${input.contextUrl}`,
  );

  // Include the chat link if the context URL points to a chat conversation
  if (input.contextUrl?.includes("/chat/")) {
    lines.push(`- Chat link: [Open conversation](${input.contextUrl})`);
  }

  if (input.screenshotUrl) {
    lines.push("", "## Screenshot", "", `![Screenshot](${input.screenshotUrl})`);
  } else if (input.screenshotDataUrl) {
    const sizeKb = Math.round(input.screenshotDataUrl.length / 1024);
    lines.push(
      "",
      "## Screenshot",
      "",
      `A screenshot (${sizeKb}KB) was captured by the reporter but could not be uploaded, ` +
        "and GitHub's issue API doesn't render inline data URIs, so it isn't embedded here " +
        "— ask the reporter to attach it manually if needed.",
    );
  }

  lines.push(
    "",
    "---",
    "_Submitted via Provide Feedback_",
  );

  return lines.join("\n");
}

export async function createGitHubTicket(
  repoFullName: string,
  token: string,
  input: GitHubTicketInput,
): Promise<GitHubTicketResult> {
  if (!token.trim()) {
    throw new Error("GitHub ticket token is not configured");
  }

  const { owner, repo } = parseGitHubRepo(repoFullName);
  const octokit = new Octokit({ auth: token });

  const labels = [input.label];
  if (input.issueType) {
    labels.push(input.issueType.toLowerCase()); // "bug" or "enhancement"
  }
  if (input.area) {
    labels.push(`area:${input.area.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-:]/g, "")}`);
  }

  const res = await octokit.issues.create({
    owner,
    repo,
    title: titleFor(input),
    body: buildGitHubIssueBody(input),
    labels: [...new Set(labels.filter(Boolean))],
  });

  const number = res.data.number;
  return {
    id: `#${number}`,
    number,
    url: res.data.html_url,
    provider: "github",
  };
}

/**
 * Dedicated branch screenshots are committed to. Deliberately NOT the repo's
 * default branch — that's commonly protected (required PR review), which
 * would make every direct-commit upload fail with a 403/422.
 */
const SCREENSHOTS_BRANCH = "screenshots";

async function ensureScreenshotsBranch(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<void> {
  try {
    await octokit.repos.getBranch({ owner, repo, branch: SCREENSHOTS_BRANCH });
  } catch (err) {
    if ((err as { status?: number })?.status !== 404) throw err;
    const { data: repoInfo } = await octokit.repos.get({ owner, repo });
    const { data: defaultRef } = await octokit.git.getRef({
      owner,
      repo,
      ref: `heads/${repoInfo.default_branch}`,
    });
    await octokit.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${SCREENSHOTS_BRANCH}`,
      sha: defaultRef.object.sha,
    });
  }
}

/**
 * Commit a captured screenshot to a dedicated screenshots repo and return
 * its raw.githubusercontent.com URL for embedding in an issue body.
 *
 * GitHub's issue API has no attachment upload endpoint, so this is the only
 * way to get a screenshot to actually render inline: host it somewhere with
 * a stable URL, here via a real commit to GITHUB_SCREENSHOTS_REPO.
 */
export async function uploadScreenshotToGitHub(
  screenshotsRepo: string,
  token: string,
  screenshotDataUrl: string,
): Promise<string> {
  const match = screenshotDataUrl.match(/^data:([\w/+-]+);base64,(.+)$/);
  if (!match) {
    throw new Error("screenshotDataUrl is not a valid base64 data URL");
  }
  const [, mimeType, base64Data] = match;
  const ext = mimeType.split("/")[1] || "png";

  const { owner, repo } = parseGitHubRepo(screenshotsRepo);
  const octokit = new Octokit({ auth: token });

  await ensureScreenshotsBranch(octokit, owner, repo);

  const path = `screenshots/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.${ext}`;

  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path,
    branch: SCREENSHOTS_BRANCH,
    message: "Add report screenshot",
    content: base64Data,
  });

  return `https://raw.githubusercontent.com/${owner}/${repo}/${SCREENSHOTS_BRANCH}/${path}`;
}
