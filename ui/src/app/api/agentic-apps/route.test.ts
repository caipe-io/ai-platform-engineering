/** @jest-environment node */
import { NextRequest } from "next/server";
import { GET } from "./route";
import { normalizeLegacyAgenticAppManifest } from "../../../../app-sdk/agentic-app-manifest.mjs";

const mockApps = jest.fn();
const mockDecision = jest.fn();
jest.mock("@/lib/agentic-apps/config", () => ({ isAgenticAppsEnabled: () => true, loadConfiguredAgenticApps: () => mockApps() }));
jest.mock("@/lib/agentic-apps/cas-compat", () => ({ evaluateAgenticAppCasCompatibility: (...args: unknown[]) => mockDecision(...args) }));
jest.mock("@/lib/api-middleware", () => ({ ApiError: class extends Error {}, getAuthenticatedUser: async () => ({
  user: { role: "user" }, session: { sub: "example-user", role: "user" },
}) }));

const makeApp = (authorization = true) => ({
  manifest: normalizeLegacyAgenticAppManifest({
    id: "example", displayName: "Example", description: "Example", surfaces: { showInHub: true },
    access: { tokenScopes: [], policyActions: [] },
    ...(authorization ? { authorization: { resourceType: "agentic_app", launchAction: "use" } } : {}),
  }),
  installation: { appId: "example", installed: true, enabled: true, visible: true },
});
beforeEach(() => { jest.clearAllMocks(); mockApps.mockReturnValue([makeApp()]); });

it("hides apps denied discovery", async () => {
  mockDecision.mockImplementation(async ({ action }) => ({ effectiveEffect: action === "read" ? "deny" : "allow" }));
  expect(await (await GET(new NextRequest("https://example.test/api/agentic-apps"))).json()).toEqual({ items: [] });
});
it.each(["NO_CAPABILITY", "AUTHZ_UNAVAILABLE"])("retains discovery but blocks launch for %s", async (reason) => {
  mockDecision.mockImplementation(async ({ action }) => ({ effectiveEffect: action === "read" ? "allow" : "deny", casReason: reason }));
  const response = await GET(new NextRequest("https://example.test/api/agentic-apps"));
  expect((await response.json()).items[0].canLaunch).toBe(false);
});
it("preserves local-only apps without CAS evaluation", async () => {
  mockApps.mockReturnValue([makeApp(false)]);
  expect((await (await GET(new NextRequest("https://example.test/api/agentic-apps"))).json()).items[0].canLaunch).toBe(true);
  expect(mockDecision).not.toHaveBeenCalled();
});
