/** @jest-environment node */
const mockApps = jest.fn();
jest.mock("@/lib/agentic-apps/config", () => ({ loadConfiguredAgenticApps: () => mockApps() }));
jest.mock("@/lib/agentic-apps/host-routes", () => ({ agenticAppHostPaths: () => ["/projects"] }));
jest.mock("@/lib/config", () => ({ getServerConfig: () => ({ ticketProvider: null }) }));
import { availableFeedbackRoutes } from "../feedback-routes.server";
const app = () => ({
  installation: { appId: "example", installed: true, enabled: true },
  manifest: { displayName: "Example", access: { requiredRoles: ["user"] },
    catalog: { feedback: { provider: "github", githubRepo: "example/product" } } },
});
beforeEach(() => mockApps.mockReturnValue([app()]));
it("registers publisher metadata as an app area", () => {
  expect(availableFeedbackRoutes({ role: "user" })).toEqual([expect.objectContaining({
    id: "app-example", appId: "example", label: "Example", provider: "github", githubRepo: "example/product",
  })]);
});
it("lets operators change or disable the publisher destination", () => {
  const configured = app();
  Object.assign(configured.installation, { feedback: { provider: "jira", jiraProject: "SUPPORT" } });
  mockApps.mockReturnValue([configured]);
  expect(availableFeedbackRoutes({ role: "user" })[0]).toMatchObject({ provider: "jira", jiraProject: "SUPPORT" });
  Object.assign(configured.installation, { feedback: null });
  expect(availableFeedbackRoutes({ role: "user" })).toEqual([]);
});
it("excludes disabled and unauthorized apps", () => {
  expect(availableFeedbackRoutes({ role: "guest" })).toEqual([]);
  const configured = app();
  configured.installation.enabled = false;
  mockApps.mockReturnValue([configured]);
  expect(availableFeedbackRoutes({ role: "user" })).toEqual([]);
});
