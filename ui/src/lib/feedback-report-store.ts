/**
 * Persist problem reports into the unified
 * `feedback` MongoDB collection so Admin → Feedback tracks all tickets.
 */

import { getCollection, isMongoDBConfigured } from "@/lib/mongodb";
import type { FeedbackContext } from "@/lib/ticket-client";
import type { GitHubTicketResult, TicketReportSource } from "@/lib/github-ticket";
import type { JiraTicketResult } from "@/lib/jira-ticket";

type AnyTicketResult = GitHubTicketResult | JiraTicketResult;

export interface RecordProblemReportInput {
  description: string;
  userEmail: string;
  contextUrl: string;
  source: TicketReportSource;
  area?: string;
  issueType?: "Bug" | "Enhancement";
  feedbackContext?: FeedbackContext;
  ticket: AnyTicketResult;
}

function valueForReport(input: RecordProblemReportInput): string {
  if (input.area) return input.area;
  if (input.feedbackContext?.reason) return input.feedbackContext.reason;
  return "problem_report";
}

/**
 * Dual-write problem reports to MongoDB. Failures are logged but do not block
 * the ticket creation response.
 */
export async function recordProblemReportFeedback(
  input: RecordProblemReportInput,
): Promise<void> {
  if (!isMongoDBConfigured) return;

  try {
    const feedbackColl = await getCollection("feedback");
    const now = new Date();

    const ticketNumber = "number" in input.ticket ? input.ticket.number : null;

    await feedbackColl.insertOne({
      source: "report",
      rating: "negative",
      value: valueForReport(input),
      comment: input.description.trim(),
      user_email: input.userEmail,
      context_url: input.contextUrl,
      report_kind: input.source,
      report_area: input.area ?? null,
      report_issue_type: input.issueType ?? null,
      ticket_provider: input.ticket.provider,
      ticket_id: input.ticket.id,
      ticket_url: input.ticket.url,
      ticket_number: ticketNumber,
      feedback_type: input.feedbackContext?.feedbackType ?? null,
      created_at: now,
      updated_at: now,
    });
  } catch (err) {
    console.warn("[feedback-report-store] Failed to write problem report:", err);
  }
}
