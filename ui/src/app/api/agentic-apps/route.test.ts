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
it.each(["NO_CAPABILITY"])("retains discovery but blocks launch for %s", async (reason) => {
  mockDecision.mockImplementation(async ({ action }) => ({ effectiveEffect: action === "read" ? "allow" : "deny", casReason: reason }));
  const response = await GET(new NextRequest("https://example.test/api/agentic-apps"));
  expect((await response.json()).items[0].canLaunch).toBe(false);
});
it("reports unavailable authorization instead of an empty or usable catalog", async () => {
  mockDecision.mockResolvedValue({ effectiveEffect: "deny", casReason: "AUTHZ_UNAVAILABLE" });
  expect((await GET(new NextRequest("https://example.test/api/agentic-apps"))).status).toBe(503);
});
it("preserves local-only apps without CAS evaluation", async () => {
  mockApps.mockReturnValue([makeApp(false)]);
  expect((await (await GET(new NextRequest("https://example.test/api/agentic-apps"))).json()).items[0].canLaunch).toBe(true);
  expect(mockDecision).not.toHaveBeenCalled();
});


function navigableApp() {
  const app = makeApp();
  return {
    ...app,
    manifest: { ...app.manifest, surfaces: { showInHub: false }, ui: {
      ...app.manifest.ui, navigation: { label: "Example", href: "/example" },
    } },
    installation: { ...app.installation, selectedUiProfile: "hosted", hostRouteClaims: ["/example"] },
  };
}

it.each(["read", "use"])("omits navigation and host-route claims when CAS denies %s", async denied => {
  mockApps.mockReturnValue([navigableApp()]);
  mockDecision.mockImplementation(async ({ action }) => ({ effectiveEffect: action === denied ? "deny" : "allow" }));
  const response = await GET(new NextRequest("https://example.test/api/agentic-apps?surface=navigation"));
  expect(await response.json()).toEqual({ items: [], hostPaths: [] });
});

it("retains authorized navigation-only apps and their owned routes", async () => {
  mockApps.mockReturnValue([navigableApp()]);
  mockDecision.mockResolvedValue({ effectiveEffect: "allow" });
  const response = await GET(new NextRequest("https://example.test/api/agentic-apps?surface=navigation"));
  const body = await response.json();
  expect(body.items).toHaveLength(1);
  expect(body.items[0]).toMatchObject({ appId: "example", canLaunch: true, navigation: { href: "/example" } });
  expect(body.hostPaths).toEqual(["/example"]);
  const hub = await GET(new NextRequest("https://example.test/api/agentic-apps"));
  expect(await hub.json()).toEqual({ items: [] });
});

it("retains authorized host-route claims even when no navigation link is shown", async () => {
  const app = navigableApp();
  mockApps.mockReturnValue([{ ...app, manifest: { ...app.manifest, ui: { ...app.manifest.ui, navigation: undefined } } }]);
  mockDecision.mockResolvedValue({ effectiveEffect: "allow" });
  const response = await GET(new NextRequest("https://example.test/api/agentic-apps?surface=navigation"));
  expect(await response.json()).toEqual({ items: [], hostPaths: ["/example"] });
});
