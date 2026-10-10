"use client";

import { apiClient } from "@/lib/api-client";
import { resolveUsableChatAgent } from "@/lib/chat-agent-selection";
import { getConfig } from "@/lib/config";
import { createStreamAdapter,type StreamCallbacks } from "@/lib/streaming";
import type { InputFieldDefinition } from "@/lib/streaming/types";

export interface FeedbackContext {
  reason: string;
  additionalFeedback?: string;
  feedbackType: "like" | "dislike";
}

export interface TicketRequest {
  description: string;
  userEmail: string;
  contextUrl: string;
  feedbackContext?: FeedbackContext;
  screenshotDataUrl?: string;
}

export interface TicketResult {
  id: string;
  url: string;
  provider: "jira" | "github";
}

export interface TicketStreamEvent {
  type: "content" | "tool_start" | "tool_end" | "input_required" | "warning" | "done" | "error";
  text?: string;
  tool?: string;
  description?: string;
  message?: string;
  fields?: Array<{
    name: string;
    label: string;
    type: string;
    required?: boolean;
  }>;
}

function buildPrompt(request: TicketRequest): string {
  const provider = getConfig("ticketProvider");
  const project =
    provider === "jira"
      ? getConfig("jiraTicketProject")
      : getConfig("githubTicketRepo");

  if (!provider || !project) {
    throw new Error("Ticket provider is not configured");
  }

  const target =
    provider === "jira"
      ? `a Jira issue in project ${project}`
      : `a GitHub issue in repository ${project}`;

  const descriptionLines = [
    `Summary: ${request.description}`,
    `Reporter: ${request.userEmail}`,
    `Context URL: ${request.contextUrl}`,
  ];

  if (request.feedbackContext) {
    descriptionLines.push(
      `Feedback Type: ${request.feedbackContext.feedbackType}`,
      `Feedback Reason: ${request.feedbackContext.reason}`
    );
    if (request.feedbackContext.additionalFeedback) {
      descriptionLines.push(
        `Additional Feedback: ${request.feedbackContext.additionalFeedback}`
      );
    }
  }

  if (request.screenshotDataUrl) {
    descriptionLines.push(`Screenshot: [attached as base64 PNG — ${Math.round(request.screenshotDataUrl.length / 1024)}KB]`);
  }

  const label =
    provider === "jira"
      ? getConfig("jiraTicketLabel")
      : getConfig("githubTicketLabel");

  const screenshotNote = request.screenshotDataUrl
    ? "\n\nA screenshot was captured by the reporter and is available as a base64 PNG attachment. Include a note in the ticket description that a screenshot was provided."
    : "";

  return `Create ${target} with the following details:\n${descriptionLines.join("\n")}\n\nSet the issue type to Bug. Add the label "${label}" to the ticket. Include the Context URL in the description so the team can navigate directly to the conversation.${screenshotNote}`;
}

/**
 * Extracts a ticket ID and URL from the final result text using common patterns.
 * Falls back to the raw text if no structured data is found.
 */
function extractTicketResult(text: string): TicketResult | null {
  const provider = getConfig("ticketProvider");
  if (!provider) return null;

  if (provider === "jira") {
    const keyMatch = text.match(/\b([A-Z][A-Z0-9]+-\d+)\b/);
    const urlMatch = text.match(/(https?:\/\/[^\s)]+\/browse\/[A-Z][A-Z0-9]+-\d+)/);
    if (keyMatch) {
      return {
        id: keyMatch[1],
        url: urlMatch ? urlMatch[1] : "",
        provider: "jira",
      };
    }
  } else {
    const numMatch = text.match(/#(\d+)/);
    const urlMatch = text.match(/(https?:\/\/github\.com\/[^\s)]+\/issues\/\d+)/);
    if (numMatch) {
      return {
        id: `#${numMatch[1]}`,
        url: urlMatch ? urlMatch[1] : "",
        provider: "github",
      };
    }
  }

  return null;
}

export interface CreateTicketOptions {
  request: TicketRequest;
  accessToken?: string;
  onEvent?: (event: TicketStreamEvent, logLine: string) => void;
  onResult?: (result: TicketResult) => void;
  signal?: AbortSignal;
}

/**
 * Create a ticket via the configured dynamic agent (Jira or GitHub).
 * Streams events back to the caller for progress display.
 */
export async function createTicketViaAgent(
  options: CreateTicketOptions
): Promise<TicketResult | null> {
  const { request, accessToken, onEvent, onResult, signal } = options;
  const prompt = buildPrompt(request);

  let finalContent = "";
  let streamError: string | null = null;

  const emitEvent = (event: TicketStreamEvent) => {
    const label = event.type || "event";
    const preview = (event.text || event.message || event.description || "")
      .slice(0, 120)
      .replace(/\n/g, "\\n") || "(no content)";
    onEvent?.(event, `<- ${label}: ${preview}`);
  };

  const agent = await resolveUsableChatAgent();
  const conversation = await apiClient.createConversation({
    title: "Support Ticket Request",
    client_type: "webui",
    agent_id: agent.id,
    metadata: {
      source: "ticket-client",
      context_url: request.contextUrl,
    },
  });

  const adapter = createStreamAdapter({
    protocol: "custom",
    accessToken,
  });

  if (signal?.aborted) {
    adapter.abort();
    return null;
  }

  if (signal) {
    signal.addEventListener("abort", () => adapter.abort(), { once: true });
  }

  const callbacks: StreamCallbacks = {
    onContent: (text) => {
      finalContent += text;
      emitEvent({ type: "content", text });
    },
    onToolStart: (_toolCallId, toolName) => {
      emitEvent({
        type: "tool_start",
        tool: toolName,
        description: `Calling ${toolName}`,
      });
    },
    onToolEnd: (_toolCallId, toolName, error) => {
      emitEvent({
        type: "tool_end",
        tool: toolName || "tool",
        message: error,
      });
    },
    onInputRequired: (_interruptId, prompt, fields) => {
      emitEvent({
        type: "input_required",
        message: prompt,
        fields: fields.map((field: InputFieldDefinition) => ({
          name: field.field_name,
          label: field.field_label || field.field_name,
          type: field.field_type,
          required: field.required,
        })),
      });
    },
    onWarning: (message) => {
      emitEvent({ type: "warning", message });
    },
    onDone: () => {
      emitEvent({ type: "done" });
    },
    onError: (message) => {
      streamError = message;
      emitEvent({ type: "error", message });
    },
  };

  await adapter.streamMessage(
    {
      message: prompt,
      conversationId: conversation.conversation._id,
      agentId: agent.id,
      // `source` MUST live inside clientContext: the custom stream consumer
      // serializes only `client_context` into the request body, and the
      // backend's ClientContext model requires `source` (422 otherwise).
      clientContext: {
        source: "webui",
        userEmail: request.userEmail,
        ticketProvider: getConfig("ticketProvider"),
      },
    },
    callbacks,
  );

  if (streamError) {
    throw new Error(streamError);
  }

  if (!finalContent) return null;

  const result = extractTicketResult(finalContent);
  if (result) {
    onResult?.(result);
  }
  return result;
}
