import { buildFeedbackRoutes, feedbackRouteForPath, parseFeedbackRoutes } from "../feedback-routing";

it("overrides one platform area and adds an app destination", () => {
  const configured = parseFeedbackRoutes(JSON.stringify([
    { id: "skills", label: "Skills", provider: "jira", jiraProject: "SKILLS", issueTypes: { Bug: "Defect" } },
    { id: "app-example", label: "Example", provider: "github", githubRepo: "example/product", appId: "example", pathPrefixes: ["/projects"] },
  ]));
  const routes = buildFeedbackRoutes(configured, "github", "example/platform", null);
  expect(routes.find(r => r.id === "skills")).toMatchObject({ jiraProject: "SKILLS", issueTypes: { Bug: "Defect" } });
  expect(routes.find(r => r.id === "chat")).toMatchObject({ githubRepo: "example/platform" });
  expect(feedbackRouteForPath(routes, "/projects/example")?.id).toBe("app-example");
  expect(feedbackRouteForPath(routes, "/projectsettings")).toBeUndefined();
});
it.each([
  [{ id: "x", label: "Example", provider: "github", githubRepo: "https://github.com/example/product" }],
  [{ id: "x", label: "Example", provider: "jira", jiraProject: "invalid/project" }],
  [{ id: "x", label: "Example", provider: "github", githubRepo: "example/product", issueTypes: { Bug: "Task" } }],
])("rejects invalid destination registration %j", rows => {
  expect(() => parseFeedbackRoutes(JSON.stringify(rows))).toThrow();
});
