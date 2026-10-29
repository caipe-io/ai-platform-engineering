/** @jest-environment node */
import { isAgenticAppBrowserContextPath } from "../config";
import type { ConfiguredAgenticApp } from "@/types/agentic-app";
const app = { gatewayPolicy: { browserContextPaths: ["/api/projects/:projectId/research"] } } as ConfiguredAgenticApp;
it.each(["project-one", "project-two"])("supports an admitted route for newly created %s", id => {
  expect(isAgenticAppBrowserContextPath(app, ["api", "projects", id, "research"])).toBe(true);
});
it.each([
  ["api", "projects", "project-one", "research", "extra"], ["api", "projects", "research"],
  ["api", "projects", "project-one", "admin"], ["api", "projects", "%2F", "research"],
  ["api", "projects", "..", "research"], ["api", "projects", "", "research"],
])("rejects a nonmatching or noncanonical path %j", (...segments) => {
  expect(isAgenticAppBrowserContextPath(app, segments)).toBe(false);
});
