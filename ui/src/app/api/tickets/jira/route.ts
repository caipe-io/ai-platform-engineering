/**
 * POST /api/tickets/jira
 *
 * Creates a Jira issue for Report a Problem.
 * Requires JIRA_BASE_URL, JIRA_EMAIL, and a token
 * (REPORT_PROBLEM_JIRA_TOKEN or JIRA_TICKET_TOKEN) with issue creation rights.
 * Project defaults to JIRA_TICKET_PROJECT.
 */

import { NextRequest, NextResponse } from "next/server";

import { withAuth, withErrorHandler, ApiError } from "@/lib/api-middleware";
import { getServerConfig } from "@/lib/config";
import {
  attachScreenshotToJiraIssue,
  createJiraTicket,
  type JiraTicketInput,
} from "@/lib/jira-ticket";
import { recordProblemReportFeedback } from "@/lib/feedback-report-store";
import type { FeedbackContext } from "@/lib/ticket-client";

interface ReportBody {
  description?: string;
  contextUrl?: string;
  area?: string;
  issueType?: "Bug" | "Enhancement";
  feedbackContext?: FeedbackContext;
  screenshotDataUrl?: string;
}

function env(name: string): string | undefined {
  return process.env[name] || process.env[`NEXT_PUBLIC_${name}`];
}

export const POST = withErrorHandler(async (request: NextRequest) => {
  return withAuth(request, async (_req, user) => {
    const cfg = getServerConfig();

    const baseUrl = env("JIRA_BASE_URL");
    const email = env("JIRA_EMAIL");
    const token = env("REPORT_PROBLEM_JIRA_TOKEN") || env("JIRA_TICKET_TOKEN");
    const projectKey = env("JIRA_TICKET_PROJECT") || cfg.jiraTicketProject;

    if (!baseUrl || !email || !token) {
      throw new ApiError(
        "Jira ticket creation is not configured (JIRA_BASE_URL, JIRA_EMAIL, REPORT_PROBLEM_JIRA_TOKEN required)",
        503,
        "jira_not_configured",
      );
    }
    if (!projectKey) {
      throw new ApiError(
        "Jira project key is not configured (JIRA_TICKET_PROJECT required)",
        503,
        "jira_project_missing",
      );
    }

    let body: ReportBody;
    try {
      body = (await request.json()) as ReportBody;
    } catch {
      throw new ApiError("Invalid JSON body", 400, "invalid_body");
    }

    const description =
      typeof body.description === "string" ? body.description.trim() : "";
    const contextUrl =
      typeof body.contextUrl === "string" ? body.contextUrl.trim() : "";
    const area = typeof body.area === "string" ? body.area.trim() : "";

    if (!description && !body.feedbackContext) {
      throw new ApiError("description is required", 400, "missing_description");
    }
    if (!contextUrl) {
      throw new ApiError("contextUrl is required", 400, "missing_context_url");
    }
    if (!area) {
      throw new ApiError("area is required", 400, "missing_area");
    }

    const input: JiraTicketInput = {
      description:
        description ||
        (body.feedbackContext
          ? `${body.feedbackContext.reason}${body.feedbackContext.additionalFeedback ? `: ${body.feedbackContext.additionalFeedback}` : ""}`
          : ""),
      userEmail: user.email,
      contextUrl,
      area,
      issueType: body.issueType,
      label: cfg.jiraTicketLabel || "platform-reported",
      feedbackContext: body.feedbackContext,
      screenshotDataUrl: typeof body.screenshotDataUrl === "string" ? body.screenshotDataUrl : undefined,
    };

    const result = await createJiraTicket(baseUrl, email, token, projectKey, input);

    if (input.screenshotDataUrl) {
      try {
        await attachScreenshotToJiraIssue(baseUrl, email, token, result.id, input.screenshotDataUrl);
      } catch (err) {
        console.warn("[api/tickets/jira] Failed to attach screenshot:", err);
      }
    }

    await recordProblemReportFeedback({
      description: input.description,
      userEmail: user.email,
      contextUrl,
      source: "header",
      area,
      issueType: body.issueType,
      feedbackContext: body.feedbackContext,
      ticket: result,
    });

    return NextResponse.json({ success: true, data: result });
  });
});
