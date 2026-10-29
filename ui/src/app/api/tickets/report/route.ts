import { NextRequest, NextResponse } from "next/server";

import { ApiError, withErrorHandler } from "@/lib/api-middleware";
import { getServerConfig } from "@/lib/config";
import { authenticateRequest } from "@/lib/da-proxy";
import { recordProblemReportFeedback } from "@/lib/feedback-report-store";
import { availableFeedbackRoutes } from "@/lib/feedback-routes.server";
import { createGitHubTicket, uploadScreenshotToGitHub, type GitHubTicketResult } from "@/lib/github-ticket";
import { attachScreenshotToJiraIssue, createJiraTicket, type JiraTicketResult } from "@/lib/jira-ticket";
import type { FeedbackContext } from "@/lib/ticket-client";

export const POST = withErrorHandler(async (request: NextRequest) => {
  const auth = await authenticateRequest(request, { resource: "feedback", scope: "submit" });
  if (auth instanceof NextResponse) return auth;
  const session = auth.authenticatedUser?.session;
  if (!auth.email || auth.isServiceAccount || session?.principalType === "catalog_api_key" || session?.principalType === "skills_api_key") {
    throw new ApiError("Sign in to submit feedback", 403);
  }
  const cfg = getServerConfig();
  if (!cfg.reportProblemEnabled) throw new ApiError("Feedback reporting is disabled", 503);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError("Invalid feedback body", 400);
  const routes = availableFeedbackRoutes(session as Record<string, unknown> ?? {}, auth.role);
  const route = body.areaId
    ? routes.find(r => r.id === body.areaId)
    : routes.find(r => r.label === body.area || r.id === body.area) ??
      (!body.area ? routes.find(r => r.id === "chat") : undefined);
  if (!route) throw new ApiError("Choose a configured feedback area", 400);
  if (body.issueType && !["Bug", "Enhancement"].includes(body.issueType)) throw new ApiError("Choose Bug or Enhancement", 400);
  const issueType: "Bug" | "Enhancement" = body.issueType || "Bug";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const contextUrl = typeof body.contextUrl === "string" ? body.contextUrl.trim() : "";
  if (!description || description.length > 20000) throw new ApiError("Provide a description of up to 20,000 characters", 400);
  try {
    if (!["http:", "https:"].includes(new URL(contextUrl).protocol)) throw new Error("protocol");
  } catch {
    throw new ApiError("Provide a valid context URL", 400);
  }
  const feedbackContext: FeedbackContext | undefined = body.feedbackContext &&
    typeof body.feedbackContext.reason === "string" && ["like", "dislike"].includes(body.feedbackContext.feedbackType)
    ? { reason: body.feedbackContext.reason.slice(0, 1000),
        feedbackType: body.feedbackContext.feedbackType,
        additionalFeedback: typeof body.feedbackContext.additionalFeedback === "string" ? body.feedbackContext.additionalFeedback.slice(0, 20000) : undefined } : undefined;
  const chatContext = typeof body.chatContext === "string" ? body.chatContext.slice(0, 14000) : undefined;
  const screenshotDataUrl = typeof body.screenshotDataUrl === "string" ? body.screenshotDataUrl : undefined;
  if (screenshotDataUrl && (screenshotDataUrl.length > 7_000_000 ||
      !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(screenshotDataUrl))) {
    throw new ApiError("Attach a PNG, JPEG, WebP or GIF smaller than 5 MB", 400);
  }
  const input = { description, userEmail: auth.email, contextUrl, area: route.label,
    issueType, feedbackContext, chatContext, appId: route.appId, labels: route.labels };
  const source = route.appId ? "app-product" : feedbackContext ? "chat-feedback" : "header";
  let ticket: GitHubTicketResult | JiraTicketResult;
  const warnings: string[] = [];
  try {
    if (route.provider === "github") {
      const token = process.env.REPORT_PROBLEM_GITHUB_TOKEN || process.env.GITHUB_TICKET_TOKEN || process.env.GITHUB_TOKEN;
      if (!token?.trim()) throw new ApiError("GitHub feedback service token is not configured", 503);
      let screenshotUrl: string | undefined;
      if (screenshotDataUrl) {
        const repo = cfg.githubScreenshotsRepo;
        if (!repo) throw new ApiError("Screenshot uploads are not configured", 503);
        screenshotUrl = await uploadScreenshotToGitHub(repo, token, screenshotDataUrl);
      }
      ticket = await createGitHubTicket(route.githubRepo!, token, {
        ...input, label: cfg.githubTicketLabel, source, screenshotUrl,
      });
    } else {
      const baseUrl = cfg.jiraBaseUrl || process.env.JIRA_BASE_URL;
      const email = process.env.JIRA_EMAIL;
      const token = process.env.REPORT_PROBLEM_JIRA_TOKEN || process.env.JIRA_TICKET_TOKEN;
      if (!baseUrl || !email || !token?.trim()) throw new ApiError("Jira feedback service credentials are not configured", 503);
      ticket = await createJiraTicket(baseUrl, email, token, route.jiraProject!, {
        ...input, label: cfg.jiraTicketLabel, jiraIssueType: route.issueTypes?.[issueType],
      });
      if (screenshotDataUrl) {
        try {
          await attachScreenshotToJiraIssue(baseUrl, email, token, ticket.id, screenshotDataUrl);
        } catch {
          warnings.push("Your issue was created, but the screenshot could not be attached. Attach it using the issue link.");
        }
      }
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const status = (error as { status?: number }).status;
    console.error("[tickets/report] Issue creation failed", { areaId: route.id, provider: route.provider, status });
    throw new ApiError(`${route.provider === "github" ? "GitHub" : "Jira"} could not create the issue. Ask an administrator to check the configured destination and service token permissions.`, 502);
  }
  await recordProblemReportFeedback({ ...input, source, ticket, routeId: route.id });
  return NextResponse.json({ success: true, data: { ...ticket, ...(warnings.length ? { warnings } : {}) } });
});
