/**
 * Server-only Jira issue creation for Report-a-Problem.
 * Uses basic auth: email (JIRA_EMAIL) + API token (REPORT_PROBLEM_JIRA_TOKEN or JIRA_TICKET_TOKEN).
 */

import type { FeedbackContext } from "@/lib/ticket-client";

export interface JiraTicketInput {
  description: string;
  userEmail: string;
  contextUrl: string;
  area: string;
  issueType?: "Bug" | "Enhancement";
  label?: string;
  feedbackContext?: FeedbackContext;
  screenshotDataUrl?: string;
}

export interface JiraTicketResult {
  id: string;
  url: string;
  provider: "jira";
}

/** Convert plain text to Atlassian Document Format (ADF) for Jira REST v3. */
function toAdfDoc(text: string): object {
  return {
    type: "doc",
    version: 1,
    content: text
      .split("\n")
      .map((line) => ({
        type: "paragraph",
        content: line
          ? [{ type: "text", text: line }]
          : [],
      })),
  };
}

function buildSummary(input: JiraTicketInput): string {
  const text = input.description.trim().replace(/\s+/g, " ");
  const summary = text.length > 100 ? `${text.slice(0, 99)}…` : text;
  const type = input.issueType ? `[${input.issueType}] ` : "";
  return `[${input.area}] ${type}${summary}`;
}

function buildDescriptionText(input: JiraTicketInput): string {
  const lines: string[] = [
    `Summary: ${input.description.trim()}`,
    `Area: ${input.area}`,
    ...(input.issueType ? [`Issue Type: ${input.issueType}`] : []),
    `Reporter: ${input.userEmail}`,
    `Context URL: ${input.contextUrl}`,
  ];
  if (input.contextUrl?.includes("/chat/")) {
    lines.push(`Chat Link: ${input.contextUrl}`);
  }
  if (input.feedbackContext) {
    lines.push(
      `Feedback Type: ${input.feedbackContext.feedbackType}`,
      `Feedback Reason: ${input.feedbackContext.reason}`,
    );
    if (input.feedbackContext.additionalFeedback) {
      lines.push(`Additional Feedback: ${input.feedbackContext.additionalFeedback}`);
    }
  }
  lines.push("", "Submitted via CAIPE Provide Feedback");
  return lines.join("\n");
}

/**
 * Map our issueType to a Jira issuetype name.
 * Service-desk projects may not expose software-specific issue types.
 * Falls back to "Task" which exists in all Jira project templates.
 */
function toJiraIssueType(issueType?: "Bug" | "Enhancement"): string {
  if (issueType === "Bug") return "[System] Problem";
  return "Task";
}

export async function createJiraTicket(
  baseUrl: string,
  email: string,
  token: string,
  projectKey: string,
  input: JiraTicketInput,
): Promise<JiraTicketResult> {
  const credentials = Buffer.from(`${email}:${token}`).toString("base64");
  const labels: string[] = [];
  if (input.label) labels.push(input.label);

  const body = {
    fields: {
      project: { key: projectKey },
      summary: buildSummary(input),
      description: toAdfDoc(buildDescriptionText(input)),
      issuetype: { name: toJiraIssueType(input.issueType) },
      ...(labels.length > 0 ? { labels } : {}),
    },
  };

  const apiUrl = `${baseUrl.replace(/\/$/, "")}/rest/api/3/issue`;
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({})) as Record<string, unknown>;
    const errorMessages = Array.isArray(errBody?.errorMessages)
      ? (errBody.errorMessages as string[]).join("; ")
      : "";
    const errors =
      typeof errBody?.errors === "object" && errBody.errors !== null
        ? Object.values(errBody.errors as Record<string, string>).join("; ")
        : "";
    const msg = errorMessages || errors || `Jira API error (${res.status})`;
    throw new Error(msg);
  }

  const data = (await res.json()) as { id: string; key: string };
  return {
    id: data.key,
    url: `${baseUrl.replace(/\/$/, "")}/browse/${data.key}`,
    provider: "jira",
  };
}

/**
 * Upload a captured screenshot as a real Jira attachment on an existing issue.
 * Unlike GitHub, Jira's REST API supports genuine binary attachments.
 */
export async function attachScreenshotToJiraIssue(
  baseUrl: string,
  email: string,
  token: string,
  issueKey: string,
  screenshotDataUrl: string,
): Promise<void> {
  const match = screenshotDataUrl.match(/^data:([\w/+-]+);base64,(.+)$/);
  if (!match) {
    throw new Error("screenshotDataUrl is not a valid base64 data URL");
  }
  const [, mimeType, base64Data] = match;
  const bytes = Buffer.from(base64Data, "base64");
  const ext = mimeType.split("/")[1] || "png";

  const credentials = Buffer.from(`${email}:${token}`).toString("base64");
  const formData = new FormData();
  formData.append("file", new Blob([bytes], { type: mimeType }), `screenshot.${ext}`);

  const apiUrl = `${baseUrl.replace(/\/$/, "")}/rest/api/3/issue/${issueKey}/attachments`;
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "X-Atlassian-Token": "no-check",
      Accept: "application/json",
    },
    body: formData,
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Jira attachment upload failed (${res.status}): ${errBody}`);
  }
}
