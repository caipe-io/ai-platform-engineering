/**
 * @jest-environment node
 */

import { NextRequest } from "next/server";

const mockGetServerConfig = jest.fn();
const mockCreateJiraTicket = jest.fn();
const mockAttachScreenshotToJiraIssue = jest.fn();
const mockRecordProblemReportFeedback = jest.fn();

const FIXED_USER = { email: "user@example.com", name: "Test User", role: "user" };

jest.mock("@/lib/api-middleware", () => {
  class ApiError extends Error {
    statusCode: number;
    code?: string;
    constructor(message: string, statusCode = 500, code?: string) {
      super(message);
      this.statusCode = statusCode;
      this.code = code;
    }
  }
  return {
    ApiError,
    withErrorHandler:
      (handler: (request: NextRequest) => Promise<Response>) =>
      async (request: NextRequest) => {
        try {
          return await handler(request);
        } catch (error) {
          const status = error instanceof ApiError ? error.statusCode : 500;
          return new Response(
            JSON.stringify({ success: false, error: (error as Error).message }),
            { status, headers: { "Content-Type": "application/json" } },
          );
        }
      },
    withAuth: async <T>(
      _request: NextRequest,
      handler: (request: NextRequest, user: typeof FIXED_USER) => Promise<T>,
    ): Promise<T> => handler(_request, FIXED_USER),
  };
});

jest.mock("@/lib/config", () => ({
  getServerConfig: () => mockGetServerConfig(),
}));

jest.mock("@/lib/jira-ticket", () => ({
  createJiraTicket: (...args: unknown[]) => mockCreateJiraTicket(...args),
  attachScreenshotToJiraIssue: (...args: unknown[]) => mockAttachScreenshotToJiraIssue(...args),
}));

jest.mock("@/lib/feedback-report-store", () => ({
  recordProblemReportFeedback: (...args: unknown[]) => mockRecordProblemReportFeedback(...args),
}));

import { POST } from "../route";

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("https://example.test/api/tickets/jira", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const BASE_CONFIG = {
  jiraTicketProject: "EXAMPLE",
  jiraTicketLabel: "platform-reported",
};

describe("POST /api/tickets/jira", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetServerConfig.mockReturnValue({ ...BASE_CONFIG });
    process.env.JIRA_BASE_URL = "https://jira.example.com";
    process.env.JIRA_EMAIL = "example-bot@example.com";
    process.env.REPORT_PROBLEM_JIRA_TOKEN = "jira-token";
    delete process.env.JIRA_TICKET_PROJECT;
    mockCreateJiraTicket.mockResolvedValue({
      id: "EXAMPLE-99",
      url: "https://jira.example.com/browse/EXAMPLE-99",
      provider: "jira",
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns 503 when Jira base URL/email/token are not configured", async () => {
    delete process.env.JIRA_BASE_URL;

    const res = await POST(
      makeRequest({ description: "x", contextUrl: "https://example.test", area: "Chat" }),
    );
    expect(res.status).toBe(503);
    expect(mockCreateJiraTicket).not.toHaveBeenCalled();
  });

  it("returns 503 when the project key is not configured", async () => {
    mockGetServerConfig.mockReturnValue({ ...BASE_CONFIG, jiraTicketProject: null });

    const res = await POST(
      makeRequest({ description: "x", contextUrl: "https://example.test", area: "Chat" }),
    );
    expect(res.status).toBe(503);
  });

  it("returns 400 when description and contextUrl are both missing", async () => {
    const res = await POST(makeRequest({ area: "Chat" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when area is missing", async () => {
    const res = await POST(
      makeRequest({ description: "Something broke", contextUrl: "https://example.test" }),
    );
    expect(res.status).toBe(400);
  });

  it("creates a Jira ticket in the configured project and records it in the feedback store", async () => {
    const res = await POST(
      makeRequest({
        description: "Please add dark mode",
        contextUrl: "https://example.test/chat/abc",
        area: "Chat",
        issueType: "Enhancement",
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      id: "EXAMPLE-99",
      url: "https://jira.example.com/browse/EXAMPLE-99",
      provider: "jira",
    });

    expect(mockCreateJiraTicket).toHaveBeenCalledWith(
      "https://jira.example.com",
      "example-bot@example.com",
      "jira-token",
      "EXAMPLE",
      expect.objectContaining({
        description: "Please add dark mode",
        userEmail: FIXED_USER.email,
        area: "Chat",
        issueType: "Enhancement",
      }),
    );

    expect(mockRecordProblemReportFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        area: "Chat",
        issueType: "Enhancement",
        ticket: expect.objectContaining({ id: "EXAMPLE-99" }),
      }),
    );
  });

  it("uploads a captured screenshot as a real Jira attachment after the issue is created", async () => {
    mockAttachScreenshotToJiraIssue.mockResolvedValue(undefined);

    await POST(
      makeRequest({
        description: "Please add dark mode",
        contextUrl: "https://example.test",
        area: "Chat",
        screenshotDataUrl: "data:image/png;base64,Zm9v",
      }),
    );

    expect(mockAttachScreenshotToJiraIssue).toHaveBeenCalledWith(
      "https://jira.example.com",
      "example-bot@example.com",
      "jira-token",
      "EXAMPLE-99",
      "data:image/png;base64,Zm9v",
    );
  });

  it("does not fail the request when the screenshot attachment upload fails", async () => {
    mockAttachScreenshotToJiraIssue.mockRejectedValue(new Error("attachment too large"));

    const res = await POST(
      makeRequest({
        description: "Please add dark mode",
        contextUrl: "https://example.test",
        area: "Chat",
        screenshotDataUrl: "data:image/png;base64,Zm9v",
      }),
    );

    expect(res.status).toBe(200);
  });

  it("does not attempt an attachment upload when no screenshot was captured", async () => {
    await POST(
      makeRequest({
        description: "Please add dark mode",
        contextUrl: "https://example.test",
        area: "Chat",
      }),
    );

    expect(mockAttachScreenshotToJiraIssue).not.toHaveBeenCalled();
  });
});
