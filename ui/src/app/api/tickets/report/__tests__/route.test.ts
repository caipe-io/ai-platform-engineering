/** @jest-environment node */
import { NextRequest, NextResponse } from "next/server";

const mockAuth = jest.fn();
const mockApps = jest.fn();
const mockProxy = jest.fn();
jest.mock("@/lib/da-proxy", () => ({ authenticateRequest: (...args: unknown[]) => mockAuth(...args) }));
jest.mock("@/lib/agentic-apps/config", () => ({ loadConfiguredAgenticApps: () => mockApps() }));
jest.mock("@/lib/agentic-apps/proxy", () => ({ proxyAgenticAppRequest: (...args: unknown[]) => mockProxy(...args) }));
jest.mock("@/lib/config", () => ({ getServerConfig: () => ({ reportProblemEnabled: true }) }));
jest.mock("@/lib/api-middleware", () => ({
  ApiError: class extends Error { constructor(message: string, public statusCode: number) { super(message); } },
  withErrorHandler: (handler: (r: NextRequest) => Promise<Response>) => async (r: NextRequest) => {
    try { return await handler(r); }
    catch (error) { return Response.json({ error: (error as Error).message }, { status: (error as { statusCode?: number }).statusCode ?? 500 }); }
  },
}));
import { POST } from "../route";

const caller = { user: { email: "reporter@example.test" }, session: { sub: "test-user" } };
const app = () => ({
  installation: { appId: "example", installed: true, enabled: true, selectedUiProfile: "native", feedbackPath: "/api/example/feedback" },
  manifest: { ui: { profiles: [{ id: "native", mode: "native-package" }], routes: [{ path: "/projects" }] } },
});
const post = (change = {}) => POST(new NextRequest("https://host.example.test/api/tickets/report", {
  method: "POST", body: JSON.stringify({ description: "Broken button", contextUrl: "https://host.example.test/projects/example", ...change }),
}));
beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.mockResolvedValue({ authenticatedUser: caller });
  mockApps.mockReturnValue([app()]);
  mockProxy.mockResolvedValue(Response.json({ success: true, data: { id: "42", provider: "github", url: "" } }));
});

it("uses the configured app path, canonical identity and existing authorized proxy", async () => {
  expect((await post({ userEmail: "spoof@example.test", feedbackPath: "/api/other" })).status).toBe(200);
  expect(mockAuth).toHaveBeenCalledWith(expect.any(NextRequest), { resource: "feedback", scope: "submit" });
  const [forwarded, context, auth] = mockProxy.mock.calls[0];
  expect(new URL(forwarded.url).pathname).toBe("/api/example/feedback");
  expect((await forwarded.json()).userEmail).toBe("reporter@example.test");
  expect(await context.params).toEqual({ appId: "example", path: ["api", "example", "feedback"] });
  expect(auth).toBe(caller);
});
it("explicitly preserves platform fallback when no app handler is registered", async () => {
  const configured = app();
  delete configured.installation.feedbackPath;
  mockApps.mockReturnValue([configured]);
  expect(await (await post()).json()).toEqual({ success: true, data: { handled: false } });
  expect(mockProxy).not.toHaveBeenCalled();
});
it("does not mistake a neighboring platform route for an app", async () => {
  expect((await (await post({ contextUrl: "https://host.example.test/projectsettings" })).json()).data.handled).toBe(false);
  expect(mockProxy).not.toHaveBeenCalled();
});
it.each([403, 404, 503])("preserves app proxy denial/failure %s instead of rerouting", async status => {
  const configured = app();
  configured.installation.enabled = false;
  mockApps.mockReturnValue([configured]);
  mockProxy.mockResolvedValue(Response.json({ error: "Unavailable" }, { status }));
  expect((await post()).status).toBe(status);
  expect(mockProxy).toHaveBeenCalledTimes(1);
});
it("preserves authentication denial", async () => {
  mockAuth.mockResolvedValue(NextResponse.json({ error: "Denied" }, { status: 401 }));
  expect((await post()).status).toBe(401);
  expect(mockProxy).not.toHaveBeenCalled();
});
it("rejects non-web context URLs", async () => {
  expect((await post({ contextUrl: "javascript:/projects/example" })).status).toBe(400);
  expect(mockProxy).not.toHaveBeenCalled();
});

it("rejects service-account submissions before app dispatch", async () => {
  mockAuth.mockResolvedValue({ authenticatedUser: caller, isServiceAccount: true });
  expect((await post()).status).toBe(403);
  expect(mockProxy).not.toHaveBeenCalled();
});
