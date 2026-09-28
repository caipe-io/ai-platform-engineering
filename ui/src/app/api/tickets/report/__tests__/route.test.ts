/**
 * @jest-environment node
 */

import { NextRequest } from "next/server";

const mockGetServerConfig = jest.fn();
const mockCreateGitHubTicket = jest.fn();
const mockUploadScreenshotToGitHub = jest.fn();
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

jest.mock("@/lib/github-ticket", () => ({
  createGitHubTicket: (...args: unknown[]) => mockCreateGitHubTicket(...args),
  uploadScreenshotToGitHub: (...args: unknown[]) => mockUploadScreenshotToGitHub(...args),
}));

jest.mock("@/lib/feedback-report-store", () => ({
  recordProblemReportFeedback: (...args: unknown[]) => mockRecordProblemReportFeedback(...args),
}));

import { POST } from "../route";

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("https://example.test/api/tickets/report", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const BASE_CONFIG = {
  githubTicketEnabled: true,
  githubTicketRepo: "org/repo",
  githubTicketLabel: "platform-reported",
  githubScreenshotsRepo: null as string | null,
};

describe("POST /api/tickets/report", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetServerConfig.mockReturnValue({ ...BASE_CONFIG });
    process.env.REPORT_PROBLEM_GITHUB_TOKEN = "ghp_test_token";
    mockCreateGitHubTicket.mockResolvedValue({
      id: "#42",
      number: 42,
      url: "https://github.com/org/repo/issues/42",
      provider: "github",
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns 503 when GitHub ticket creation is not configured", async () => {
    mockGetServerConfig.mockReturnValue({ ...BASE_CONFIG, githubTicketEnabled: false });

    const res = await POST(makeRequest({ description: "x", contextUrl: "https://example.test" }));
    expect(res.status).toBe(503);
    expect(mockCreateGitHubTicket).not.toHaveBeenCalled();
  });

  it("returns 503 when the token is missing", async () => {
    delete process.env.REPORT_PROBLEM_GITHUB_TOKEN;
    delete process.env.GITHUB_TICKET_TOKEN;
    delete process.env.GITHUB_TOKEN;

    const res = await POST(makeRequest({ description: "x", contextUrl: "https://example.test" }));
    expect(res.status).toBe(503);
  });

  it("returns 400 when description and contextUrl are both missing", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
  });

  it("returns 400 when contextUrl is missing", async () => {
    const res = await POST(makeRequest({ description: "Something broke" }));
    expect(res.status).toBe(400);
  });

  it("creates a GitHub ticket and records it in the feedback store with area/issueType", async () => {
    const res = await POST(
      makeRequest({
        description: "Something broke",
        contextUrl: "https://example.test/chat/abc",
        area: "Knowledge",
        issueType: "Bug",
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      id: "#42",
      number: 42,
      url: "https://github.com/org/repo/issues/42",
      provider: "github",
    });

    expect(mockCreateGitHubTicket).toHaveBeenCalledWith(
      "org/repo",
      "ghp_test_token",
      expect.objectContaining({
        description: "Something broke",
        userEmail: FIXED_USER.email,
        area: "Knowledge",
        issueType: "Bug",
      }),
    );

    expect(mockRecordProblemReportFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        area: "Knowledge",
        issueType: "Bug",
        ticket: expect.objectContaining({ id: "#42" }),
      }),
    );
  });

  it("uploads the screenshot and passes screenshotUrl through when a screenshots repo is configured", async () => {
    mockGetServerConfig.mockReturnValue({ ...BASE_CONFIG, githubScreenshotsRepo: "org/screenshots" });
    mockUploadScreenshotToGitHub.mockResolvedValue(
      "https://raw.githubusercontent.com/org/screenshots/screenshots/screenshots/2026-01-01/abc.png",
    );

    await POST(
      makeRequest({
        description: "Something broke",
        contextUrl: "https://example.test",
        area: "Knowledge",
        issueType: "Bug",
        screenshotDataUrl: "data:image/png;base64,Zm9v",
      }),
    );

    expect(mockUploadScreenshotToGitHub).toHaveBeenCalledWith(
      "org/screenshots",
      "ghp_test_token",
      "data:image/png;base64,Zm9v",
    );
    expect(mockCreateGitHubTicket).toHaveBeenCalledWith(
      "org/repo",
      "ghp_test_token",
      expect.objectContaining({
        screenshotUrl: "https://raw.githubusercontent.com/org/screenshots/screenshots/screenshots/2026-01-01/abc.png",
      }),
    );
  });

  it("does not fail the request when screenshot upload fails — falls back to no screenshotUrl", async () => {
    mockGetServerConfig.mockReturnValue({ ...BASE_CONFIG, githubScreenshotsRepo: "org/screenshots" });
    mockUploadScreenshotToGitHub.mockRejectedValue(new Error("branch protection or repo access error"));

    const res = await POST(
      makeRequest({
        description: "Something broke",
        contextUrl: "https://example.test",
        area: "Knowledge",
        issueType: "Bug",
        screenshotDataUrl: "data:image/png;base64,Zm9v",
      }),
    );

    expect(res.status).toBe(200);
    expect(mockCreateGitHubTicket).toHaveBeenCalledWith(
      "org/repo",
      "ghp_test_token",
      expect.objectContaining({ screenshotUrl: undefined }),
    );
  });

  it("does not upload a screenshot when no screenshots repo is configured", async () => {
    await POST(
      makeRequest({
        description: "Something broke",
        contextUrl: "https://example.test",
        area: "Knowledge",
        issueType: "Bug",
        screenshotDataUrl: "data:image/png;base64,Zm9v",
      }),
    );

    expect(mockUploadScreenshotToGitHub).not.toHaveBeenCalled();
  });

  it("falls back to feedbackContext-derived description when no description is provided", async () => {
    const res = await POST(
      makeRequest({
        contextUrl: "https://example.test/chat/abc",
        feedbackContext: { reason: "Inaccurate", feedbackType: "dislike" },
      }),
    );

    expect(res.status).toBe(200);
    expect(mockCreateGitHubTicket).toHaveBeenCalledWith(
      "org/repo",
      "ghp_test_token",
      expect.objectContaining({ description: "Inaccurate" }),
    );
  });
});
