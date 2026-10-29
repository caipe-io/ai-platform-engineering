/** @jest-environment node */
import { NextRequest, NextResponse } from "next/server";
const mockAuth = jest.fn();
const mockRoutes = jest.fn();
const mockGithub = jest.fn();
const mockJira = jest.fn();
const mockAttach = jest.fn();
jest.mock("@/lib/da-proxy", () => ({ authenticateRequest: (...args: unknown[]) => mockAuth(...args) }));
jest.mock("@/lib/config", () => ({ getServerConfig: () => ({ reportProblemEnabled: true }) }));
jest.mock("@/lib/feedback-routes.server", () => ({ availableFeedbackRoutes: () => mockRoutes() }));
jest.mock("@/lib/github-ticket", () => ({ createGitHubTicket: (...args: unknown[]) => mockGithub(...args), uploadScreenshotToGitHub: jest.fn() }));
jest.mock("@/lib/jira-ticket", () => ({ createJiraTicket: (...args: unknown[]) => mockJira(...args), attachScreenshotToJiraIssue: (...args: unknown[]) => mockAttach(...args) }));
jest.mock("@/lib/feedback-report-store", () => ({ recordProblemReportFeedback: jest.fn() }));
jest.mock("@/lib/api-middleware", () => ({
  ApiError: class extends Error { constructor(message: string, public statusCode: number) { super(message); } },
  withErrorHandler: (handler: (r: NextRequest) => Promise<Response>) => async (r: NextRequest) => {
    try { return await handler(r); }
    catch (error) { return Response.json({ error: (error as Error).message }, { status: (error as { statusCode?: number }).statusCode ?? 500 }); }
  },
}));
import { POST } from "../route";
const originalEnv = { ...process.env };
const valid = { areaId: "app-example", issueType: "Enhancement", description: "Please improve navigation", contextUrl: "https://host.example.test/projects" };
const post = (change = {}) => POST(new NextRequest("https://host.example.test/api/tickets/report", { method: "POST", body: JSON.stringify({ ...valid, ...change }) }));
beforeEach(() => {
  jest.clearAllMocks();
  process.env.REPORT_PROBLEM_GITHUB_TOKEN = "test-github-token";
  process.env.REPORT_PROBLEM_JIRA_TOKEN = "test-jira-token";
  process.env.JIRA_EMAIL = "service@example.test";
  process.env.JIRA_BASE_URL = "https://jira.example.test";
  mockAuth.mockResolvedValue({ email: "reporter@example.test", role: "user", authenticatedUser: { session: {} } });
  mockRoutes.mockReturnValue([{ id: "app-example", label: "Example", appId: "example", provider: "github", githubRepo: "example/product" }]);
  mockGithub.mockResolvedValue({ id: "#1", provider: "github", url: "https://github.com/example/product/issues/1" });
  mockJira.mockResolvedValue({ id: "SUPPORT-1", provider: "jira", url: "https://jira.example.test/browse/SUPPORT-1" });
});
afterAll(() => { process.env = originalEnv; });
it("uses registered destinations and authenticated identity despite browser overrides", async () => {
  expect((await post({ githubRepo: "example/other", userEmail: "spoof@example.test" })).status).toBe(200);
  expect(mockAuth).toHaveBeenCalledWith(expect.any(NextRequest), { resource: "feedback", scope: "submit" });
  expect(mockGithub).toHaveBeenCalledWith("example/product", "test-github-token", expect.objectContaining({
    userEmail: "reporter@example.test", appId: "example", area: "Example", source: "app-product", issueType: "Enhancement",
  }));
});
it("routes Jira projects and their registered issue types", async () => {
  mockRoutes.mockReturnValue([{ id: "app-example", label: "Example", provider: "jira", jiraProject: "SUPPORT", issueTypes: { Enhancement: "Request" } }]);
  expect((await post()).status).toBe(200);
  expect(mockJira).toHaveBeenCalledWith("https://jira.example.test", "service@example.test", "test-jira-token", "SUPPORT", expect.objectContaining({ jiraIssueType: "Request" }));
  expect(mockGithub).not.toHaveBeenCalled();
});
it("does not fall back when a removed or unauthorized destination is submitted", async () => {
  expect((await post({ areaId: "unregistered" })).status).toBe(400);
  expect(mockGithub).not.toHaveBeenCalled();
});
it("preserves authentication denial", async () => {
  mockAuth.mockResolvedValue(NextResponse.json({ error: "Sign in" }, { status: 401 }));
  expect((await post()).status).toBe(401);
  expect(mockGithub).not.toHaveBeenCalled();
});
it("reports provider errors without returning a misleading application 404", async () => {
  mockGithub.mockRejectedValue({ status: 404 });
  expect((await post()).status).toBe(502);
});
it("preserves a created ticket when Jira attachment upload fails", async () => {
  mockRoutes.mockReturnValue([{ id: "app-example", label: "Example", provider: "jira", jiraProject: "SUPPORT" }]);
  mockAttach.mockRejectedValue(new Error("Upload unavailable"));
  const response = await post({ screenshotDataUrl: "data:image/png;base64,AAAA" });
  expect(response.status).toBe(200);
  expect((await response.json()).data.warnings).toHaveLength(1);
  expect(mockJira).toHaveBeenCalledTimes(1);
});
