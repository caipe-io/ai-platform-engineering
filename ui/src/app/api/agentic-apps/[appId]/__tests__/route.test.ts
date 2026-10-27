/** @jest-environment node */
import { NextRequest } from "next/server";

import { normalizeLegacyAgenticAppManifest } from "../../../../../../app-sdk/agentic-app-manifest.mjs";

const mockAuthenticate = jest.fn();
const mockLookup = jest.fn();
const mockList = jest.fn();
jest.mock("@/lib/api-middleware", () => ({
  ApiError: class ApiError extends Error {
    statusCode = 401;
  },
  getAuthenticatedUser: (...args: unknown[]) => mockAuthenticate(...args),
}));
jest.mock("@/lib/agentic-apps/config", () => ({
  isAgenticAppsEnabled: () => true,
  getConfiguredAgenticApp: (...args: unknown[]) => mockLookup(...args),
  loadConfiguredAgenticApps: () => mockList(),
}));

import { GET } from "../route";
import { GET as catalog } from "../../route";

const app = {
  manifest: normalizeLegacyAgenticAppManifest({
    id: "example-app",
    displayName: "Example",
    description: "Example",
    apiVersion: "1.0",
    auth: { mode: "app-scoped-token" },
    surfaces: { showInHub: false },
    access: { requiredRoles: ["user"], tokenScopes: [], policyActions: [] },
    runtime: {
      kind: "proxied-next-zone",
      origin: "https://runtime.example.test",
      mountPath: "/apps/example-app",
    },
  }),
  installation: {
    appId: "example-app",
    packageId: "example-app",
    installed: true,
    enabled: true,
    visible: false,
    selectedUiProfile: "hosted",
  },
};
const request = () =>
  new NextRequest("https://host.example.test/api/agentic-apps/example-app");
const context = { params: Promise.resolve({ appId: "example-app" }) };

describe("authorized app lookup", () => {
  beforeEach(() => {
    mockAuthenticate.mockResolvedValue({
      session: { sub: "test-user", role: "user" },
      user: { role: "user" },
    });
    mockLookup.mockReturnValue(app);
    mockList.mockReturnValue([app]);
  });

  it("opens an authorized hidden iframe without leaking private bindings", async () => {
    const response = await GET(request(), context);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.item.uiMode).toBe("iframe");
    expect(body.item.href).toBe("/apps/example-app");
    expect(JSON.stringify(body)).not.toContain("runtime.example.test");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await (await catalog(request())).json()).toEqual({ items: [] });
  });

  it("does not let hidden or declarative capabilities bypass role authorization", async () => {
    mockAuthenticate.mockResolvedValue({
      session: { sub: "test-user", role: "viewer" },
      user: { role: "viewer" },
    });
    expect((await GET(request(), context)).status).toBe(403);
  });

  it("blocks disabled, missing, and service-only app UI", async () => {
    for (const candidate of [
      null,
      { ...app, installation: { ...app.installation, enabled: false } },
      {
        ...app,
        manifest: { ...app.manifest, ui: { profiles: [], routes: [] } },
      },
    ]) {
      mockLookup.mockReturnValue(candidate);
      expect((await GET(request(), context)).status).toBe(404);
    }
  });

  it("requires authenticated identity even when the app is hidden", async () => {
    mockAuthenticate.mockResolvedValue({ session: {}, user: { role: "user" } });
    expect((await GET(request(), context)).status).toBe(401);
  });
});
