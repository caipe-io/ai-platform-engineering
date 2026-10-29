/** @jest-environment node */
import { NextRequest, NextResponse } from "next/server";
const mockAuth = jest.fn();
const mockJira = jest.fn();
jest.mock("@/lib/da-proxy", () => ({ authenticateRequest: () => mockAuth() }));
jest.mock("@/lib/config", () => ({ getServerConfig: () => ({ reportProblemEnabled: true }) }));
jest.mock("@/lib/feedback-routes.server", () => ({ availableFeedbackRoutes: () => [
  { id: "skills", label: "Skills", provider: "jira", jiraProject: "SKILLS" },
] }));
jest.mock("@/lib/jira-ticket", () => ({ createJiraTicket: (...args: unknown[]) => mockJira(...args) }));
jest.mock("@/lib/github-ticket", () => ({}));
jest.mock("@/lib/feedback-report-store", () => ({ recordProblemReportFeedback: jest.fn() }));
jest.mock("@/lib/api-middleware", () => ({ withErrorHandler: (handler: unknown) => handler }));
import { POST } from "../route";
const post = () => POST(new NextRequest("https://host.example.test/api/tickets/jira", {
  method: "POST", body: JSON.stringify({ area: "Skills", description: "Broken button", contextUrl: "https://host.example.test/skills" }),
}));
const originalEnv = { ...process.env };
afterAll(() => { process.env = originalEnv; });
it("keeps legacy app submissions on the registered Jira project", async () => {
  process.env.JIRA_BASE_URL = "https://jira.example.test";
  process.env.JIRA_EMAIL = "service@example.test";
  process.env.REPORT_PROBLEM_JIRA_TOKEN = "test-token";
  mockAuth.mockResolvedValue({ email: "reporter@example.test" });
  mockJira.mockResolvedValue({ provider: "jira", id: "SKILLS-1", url: "https://jira.example.test/browse/SKILLS-1" });
  expect((await post()).status).toBe(200);
  expect(mockJira).toHaveBeenCalledWith("https://jira.example.test", "service@example.test", "test-token", "SKILLS", expect.objectContaining({ userEmail: "reporter@example.test", area: "Skills" }));
});
it("preserves host authorization denial on the legacy path", async () => {
  mockAuth.mockResolvedValue(NextResponse.json({ error: "Denied" }, { status: 403 }));
  expect((await post()).status).toBe(403);
});
