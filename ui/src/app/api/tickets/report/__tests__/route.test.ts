/** @jest-environment node */
import { NextRequest, NextResponse } from "next/server";

const mockAuth = jest.fn();
const mockApps = jest.fn();
const mockProxy = jest.fn();
const mockConversation = jest.fn();
const mockResourcePermission = jest.fn();
const mockPlatformFeedback = jest.fn();
const mockPlatformCapabilities = jest.fn();
let mockPlatformHandler = "agent";
let mockMongoConfigured = false;
jest.mock("@/lib/feedback-github", () => ({
  appGitHubFeedbackSettings: () => ({ repo: "example/product", token: "test-app-token", features: ["Publishing"] }),
  createGitHubFeedback: (...args: unknown[]) => mockPlatformFeedback(...args),
  platformFeedbackHandler: () => mockPlatformHandler,
  platformFeedbackCapabilities: () => mockPlatformCapabilities(),
  createPlatformGitHubFeedback: (...args: unknown[]) => mockPlatformFeedback(...args),
}));
jest.mock("@/lib/da-proxy", () => ({ authenticateRequest: (...args: unknown[]) => mockAuth(...args) }));
jest.mock("@/lib/agentic-apps/config", () => ({ loadConfiguredAgenticApps: () => mockApps() }));
jest.mock("@/lib/agentic-apps/proxy", () => ({ proxyAgenticAppRequest: (...args: unknown[]) => mockProxy(...args) }));
jest.mock("@/lib/config", () => ({ getServerConfig: () => ({ reportProblemEnabled: true, appName: "Platform" }) }));
jest.mock("@/lib/mongodb", () => ({ get isMongoDBConfigured() { return mockMongoConfigured; }, getCollection: jest.fn() }));
jest.mock("@/lib/rbac/conversation-implicit-authz", () => ({ requireConversationResourcePermission: (...args: unknown[]) => mockResourcePermission(...args) }));
jest.mock("@/lib/api-middleware", () => ({
  ApiError: class extends Error { constructor(message: string, public statusCode: number) { super(message); } },
  requireConversationAccess: (...args: unknown[]) => mockConversation(...args),
  validateConversationId: (value: string) => /^[A-Za-z0-9-]+$/.test(value),
  withErrorHandler: (handler: (r: NextRequest) => Promise<Response>) => async (r: NextRequest) => {
    try { return await handler(r); }
    catch (error) { return Response.json({ error: (error as Error).message }, { status: (error as { statusCode?: number }).statusCode ?? 500 }); }
  },
}));
import { GET, POST } from "../route";
import { ApiError } from "@/lib/api-middleware";

const originalFeatures = process.env.FEEDBACK_FEATURES;
const originalPlatformLabel = process.env.FEEDBACK_PLATFORM_LABEL;
afterAll(() => { if (originalPlatformLabel === undefined) delete process.env.FEEDBACK_PLATFORM_LABEL; else process.env.FEEDBACK_PLATFORM_LABEL = originalPlatformLabel; });
afterAll(() => { if (originalFeatures === undefined) delete process.env.FEEDBACK_FEATURES; else process.env.FEEDBACK_FEATURES = originalFeatures; });

const caller = { user: { email: "reporter@example.test" }, session: { sub: "test-user" } };
const app = () => ({
  installation: { appId: "example", installed: true, enabled: true, selectedUiProfile: "native", feedbackPath: "/api/example/feedback" },
  manifest: { displayName: "Example app", access: {}, ui: { profiles: [{ id: "native", mode: "native-package" }], routes: [{ path: "/projects" }] } },
});
const post = (change = {}) => POST(new NextRequest("https://host.example.test/api/tickets/report", {
  method: "POST", body: JSON.stringify({ description: "Broken button", contextUrl: "https://host.example.test/projects/example", ...change }),
}));
beforeEach(() => {
  jest.clearAllMocks();
  mockMongoConfigured = false;
  mockPlatformHandler = "agent";
  mockPlatformCapabilities.mockReset().mockReturnValue({});
  delete process.env.FEEDBACK_FEATURES;
  delete process.env.FEEDBACK_PLATFORM_LABEL;
  mockResourcePermission.mockResolvedValue(undefined);
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
  expect(await (await post()).json()).toEqual({ success: true, data: { handled: false, componentId: null } });
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

it("forwards the guided report and thumbs context together to the owning app", async () => {
  const report = {
    title: "The answer misses a step", issueType: "Bug",
    sections: [{ label: "Steps to reproduce", value: "Ask the assistant" }],
    relatedUrl: "https://example.test/item",
    feedbackContext: { feedbackType: "dislike", reason: "Other", additionalFeedback: "Missing a step" },
  };
  expect((await post(report)).status).toBe(200);
  expect(await mockProxy.mock.calls[0][0].json()).toEqual(expect.objectContaining(report));
});

const options = (contextUrl = "https://host.example.test/projects/example", conversationId?: string) => GET(new NextRequest(
  "https://host.example.test/api/tickets/report?" + new URLSearchParams({ contextUrl, ...(conversationId ? { conversationId } : {}) }),
));
it("uses configured platform features on platform pages", async () => {
  process.env.FEEDBACK_FEATURES = JSON.stringify(["Chat", "Connected Credentials", "Other"]);
  const response = await options("https://host.example.test/chat");
  expect((await response.json()).data).toEqual({ appId: null, label: "Platform", features: ["Chat", "Connected Credentials", "Other"], components: [{ appId: null, label: "Platform" }, { appId: "example", label: "Example app" }] });
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});
it("uses an installation's features without exposing runtime bindings", async () => {
  const configured = app();
  Object.assign(configured.installation, { feedbackFeatures: ["Routing", "Other"] });
  mockApps.mockReturnValue([configured]);
  expect((await (await options()).json()).data).toEqual({ appId: "example", label: "Example app", features: ["Routing", "Other"], components: [{ appId: null, label: "Platform" }, { appId: "example", label: "Example app" }] });
  expect(mockProxy).not.toHaveBeenCalled();
});
it("uses app-owned feature capabilities when no installation override exists", async () => {
  mockProxy.mockResolvedValue(Response.json({ data: { features: ["Publishing", "Other"], screenshotsEnabled: true } }));
  expect((await (await options()).json()).data.features).toEqual(["Publishing", "Other"]);
  expect(mockProxy.mock.calls[0][0].method).toBe("GET");
});
it("keeps POST-only app handlers isolated from platform categories", async () => {
  mockProxy.mockResolvedValue(Response.json({}, { status: 405 }));
  expect((await (await options()).json()).data.features).toEqual(["Other"]);
});
it("denies unavailable apps instead of showing platform categories", async () => {
  const configured = app(); configured.installation.enabled = false; mockApps.mockReturnValue([configured]);
  expect((await options()).status).toBe(403);
});
it("keeps an app conversation scoped in shared Chat for both options and submission", async () => {
  mockMongoConfigured = true;
  mockConversation.mockResolvedValue({ conversation: { _id: "test-conversation", metadata: { agentic_app_id: "example" } } });
  mockProxy.mockResolvedValue(Response.json({ data: { features: ["Publishing", "Other"] } }));
  expect((await (await options("https://host.example.test/chat/test-conversation", "test-conversation")).json()).data.appId).toBe("example");
  expect(mockResourcePermission).toHaveBeenCalledWith(caller.session, caller.user.email, expect.any(Object), "read");
  mockProxy.mockResolvedValue(Response.json({ data: { id: "42", provider: "github" } }));
  expect((await post({ contextUrl: "https://host.example.test/chat/test-conversation", conversationId: "test-conversation" })).status).toBe(200);
  expect(mockProxy.mock.calls.at(-1)[0].method).toBe("POST");
});
it("does not reveal a conversation's app without read access", async () => {
  mockMongoConfigured = true;
  mockConversation.mockRejectedValue(Object.assign(new Error("Forbidden"), { statusCode: 403 }));
  expect((await options("https://host.example.test/chat", "test-conversation")).status).toBe(403);
  expect(mockProxy).not.toHaveBeenCalled();
});
it("rejects invalid platform configuration", async () => {
  process.env.FEEDBACK_FEATURES = "not-json";
  expect((await options("https://host.example.test/chat")).status).toBe(500);
});

it("resolves a header report on an app chat from its canonical conversation URL", async () => {
  mockMongoConfigured = true;
  mockConversation.mockResolvedValue({ conversation: { _id: "test-conversation", metadata: { agentic_app_id: "example" } } });
  expect((await (await options("https://host.example.test/chat/test-conversation")).json()).data.appId).toBe("example");
});
it("preserves authentication denial for category discovery", async () => {
  mockAuth.mockResolvedValue(NextResponse.json({ error: "Denied" }, { status: 401 }));
  expect((await options()).status).toBe(401);
  expect(mockApps).not.toHaveBeenCalled();
});

const componentOptions = (componentId: string | null, contextUrl = "https://host.example.test/chat", view?: string) => GET(new NextRequest(
  "https://host.example.test/api/tickets/report?" + new URLSearchParams({ contextUrl, componentId: componentId ?? "", ...(view ? { view } : {}) }),
));
it("discovers only registered, available components the reporter can access", async () => {
  const unregistered = app(); Object.assign(unregistered.installation, { appId: "unregistered", feedbackPath: undefined });
  const disabled = app(); Object.assign(disabled.installation, { appId: "disabled", enabled: false });
  const restricted = app(); Object.assign(restricted.installation, { appId: "restricted", accessOverrides: { requiredRoles: ["admin"] } });
  mockApps.mockReturnValue([app(), unregistered, disabled, restricted]);
  const data = (await (await componentOptions(null, undefined, "components")).json()).data;
  expect(data).toEqual({ appId: null, components: [{ appId: null, label: "Platform" }, { appId: "example", label: "Example app" }] });
  expect(mockProxy).not.toHaveBeenCalled();
});
it("selects a registered app's features and handler from a platform page", async () => {
  mockProxy.mockResolvedValue(Response.json({ data: { features: ["Publishing", "Other"] } }));
  expect((await (await componentOptions("example")).json()).data.appId).toBe("example");
  mockProxy.mockClear();
  mockProxy.mockResolvedValue(Response.json({ data: { id: "42", provider: "github" } }));
  expect((await post({ contextUrl: "https://host.example.test/chat", componentId: "example", feature: "Publishing" })).status).toBe(200);
  expect(await mockProxy.mock.calls[0][1].params).toEqual({ appId: "example", path: ["api", "example", "feedback"] });
});
it("allows explicit platform feedback from an app page without app dispatch", async () => {
  expect((await (await componentOptions(null, "https://host.example.test/projects/example")).json()).data.appId).toBeNull();
  expect((await (await post({ componentId: null })).json()).data.handled).toBe(false);
  expect(mockProxy).not.toHaveBeenCalled();
});
it.each(["missing", 5, ""])("rejects invalid or unregistered component %s", async componentId => {
  expect((await post({ componentId })).status).toBe(400);
  expect(mockProxy).not.toHaveBeenCalled();
});
it("denies an explicitly selected app the reporter cannot launch", async () => {
  const configured = app(); Object.assign(configured.installation, { accessOverrides: { requiredRoles: ["admin"] } });
  mockApps.mockReturnValue([configured]);
  expect((await componentOptions("example")).status).toBe(403);
  expect((await post({ componentId: "example" })).status).toBe(403);
  expect(mockProxy).not.toHaveBeenCalled();
});
it("keeps conversation read authorization when the component is explicitly changed", async () => {
  mockMongoConfigured = true;
  mockConversation.mockRejectedValue(Object.assign(new Error("Forbidden"), { statusCode: 403 }));
  expect((await post({ componentId: null, conversationId: "test-conversation" })).status).toBe(403);
});

it("allows a configured platform component label independent of app branding", async () => {
  process.env.FEEDBACK_PLATFORM_LABEL = "Primary platform";
  const data = (await (await componentOptions(null)).json()).data;
  expect(data.label).toBe("Primary platform");
  expect(data.components[0]).toEqual({ appId: null, label: "Primary platform" });
});

it("uses the platform's own handler and authenticated reporter for a platform component", async () => {
  mockPlatformHandler = "github";
  mockPlatformFeedback.mockResolvedValue({ id: "#42", provider: "github", url: "https://github.com/example/feedback/issues/42" });
  const response = await post({ componentId: null, userEmail: "spoof@example.test" });
  expect((await response.json()).data.id).toBe("#42");
  expect(mockPlatformFeedback).toHaveBeenCalledWith(expect.any(Object), caller.user.email, expect.any(AbortSignal));
  expect(mockProxy).not.toHaveBeenCalled();
});
it("leaves registered app handlers independent of the platform handler", async () => {
  mockPlatformHandler = "github";
  expect((await post({ componentId: "example" })).status).toBe(200);
  expect(mockPlatformFeedback).not.toHaveBeenCalled();
  expect(mockProxy).toHaveBeenCalledTimes(1);
});
it("surfaces platform handler failure without falling back to another handler", async () => {
  mockPlatformHandler = "github";
  mockPlatformFeedback.mockRejectedValue(Object.assign(new Error("Repository unavailable"), { statusCode: 502 }));
  expect((await post({ componentId: null })).status).toBe(502);
  expect(mockProxy).not.toHaveBeenCalled();
});


it("creates app issues in the host handler without proxying to an app endpoint", async () => {
  const configured = { ...app(), installation: { ...app().installation, feedbackPath: undefined,
    feedbackGitHub: { repository: "example/product", tokenEnv: "FEEDBACK_EXAMPLE_TOKEN" }, feedbackFeatures: ["Publishing"] } };
  mockApps.mockReturnValue([configured]);
  mockPlatformFeedback.mockResolvedValue({ id: "42", provider: "github", url: "https://example.test/issues/42" });
  expect((await post({ componentId: "example", feature: "Publishing", repository: "spoofed/repo" })).status).toBe(200);
  expect(mockPlatformFeedback).toHaveBeenCalledWith(expect.any(Object), "reporter@example.test", expect.any(AbortSignal),
    expect.objectContaining({ repo: "example/product", token: "test-app-token" }));
  expect(mockProxy).not.toHaveBeenCalled();
});


it("checks app launch access before creating an inferred host-managed report", async () => {
  mockApps.mockReturnValue([{ ...app(), installation: { ...app().installation, enabled: false, feedbackPath: undefined,
    feedbackGitHub: { repository: "example/product", tokenEnv: "FEEDBACK_EXAMPLE_TOKEN" }, feedbackFeatures: ["Publishing"] } }]);
  expect((await post()).status).toBe(403);
  expect(mockPlatformFeedback).not.toHaveBeenCalled();
  expect(mockProxy).not.toHaveBeenCalled();
});

it("accepts a POST-only app's undeclared discovery GET without platform categories", async () => {
  mockProxy.mockResolvedValue(Response.json({ error: "policy_denied", reasonCode: "action_not_declared" }, { status: 403 }));
  const response = await options();
  expect(response.status).toBe(200);
  expect((await response.json()).data).toMatchObject({ appId: "example", features: ["Other"] });
});
it.each(["declared_denied", undefined])("preserves category discovery denials with reason %s", async reasonCode => {
  mockProxy.mockResolvedValue(Response.json({ error: "policy_denied", reasonCode }, { status: 403 }));
  const response = await options();
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: "policy_denied", ...(reasonCode ? { reasonCode } : {}) });
});
it("never forwards an app's unhandled response as platform fallback", async () => {
  mockProxy.mockResolvedValue(Response.json({ data: { handled: false, componentId: null } }));
  expect((await post()).status).toBe(502);
  expect(mockPlatformFeedback).not.toHaveBeenCalled();
});
it("excludes an unconfigured platform while leaving registered apps usable", async () => {
  mockPlatformCapabilities.mockImplementation(() => { throw new ApiError("Not configured", 503); });
  const response = await options();
  expect(response.status).toBe(200);
  expect((await response.json()).data.components).toEqual([{ appId: "example", label: "Example app" }]);
  expect((await componentOptions(null)).status).toBe(503);
  expect((await post({ componentId: null })).status).toBe(503);
  mockProxy.mockClear();
  const registry = await GET(new NextRequest("https://host.example.test/api/tickets/report?" + new URLSearchParams({
    contextUrl: "https://host.example.test/chat", view: "components",
  })));
  expect((await registry.json()).data).toEqual({ appId: "example", components: [{ appId: "example", label: "Example app" }] });
  expect(mockProxy).not.toHaveBeenCalled();
});
it("rejects oversized declared bodies without reading or dispatching", async () => {
  const request = new NextRequest("https://host.example.test/api/tickets/report", {
    method: "POST", headers: { "content-length": String(11 * 1024 * 1024) }, body: "{}",
  });
  const reader = jest.spyOn(request.body!, "getReader");
  expect((await POST(request)).status).toBe(413);
  expect(reader).not.toHaveBeenCalled();
  expect(mockApps).not.toHaveBeenCalled();
});
it.each([undefined, "1"])("cancels oversized streamed bodies with content length %s before parsing", async contentLength => {
  const cancel = jest.fn();
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(11 * 1024 * 1024)); }, cancel,
  });
  const request = new NextRequest("https://host.example.test/api/tickets/report", {
    method: "POST", headers: contentLength ? { "content-length": contentLength } : {}, body: stream,
    duplex: "half",
  } as RequestInit);
  expect((await POST(request)).status).toBe(413);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(mockApps).not.toHaveBeenCalled();
  expect(mockProxy).not.toHaveBeenCalled();
});
it("rejects invalid JSON without dispatching", async () => {
  expect((await POST(new NextRequest("https://host.example.test/api/tickets/report", { method: "POST", body: "{" }))).status).toBe(400);
  expect(mockProxy).not.toHaveBeenCalled();
});

it("returns the configured destination without exposing app credentials", async () => {
  mockApps.mockReturnValue([{ ...app(), installation: { ...app().installation, feedbackPath: undefined,
    feedbackGitHub: { repository: "example/product", tokenEnv: "FEEDBACK_EXAMPLE_TOKEN" }, feedbackFeatures: ["Publishing"] } }]);
  const response = await componentOptions("example");
  const metadata = await response.json();
  expect(metadata.data.destination).toEqual({ provider: "github", repository: "example/product" });
  expect(JSON.stringify(metadata)).not.toContain("test-app-token");
  expect(JSON.stringify(metadata)).not.toContain("tokenEnv");
});
it("returns the platform's destination independently of the calling app", async () => {
  mockPlatformCapabilities.mockReturnValue({ destination: { provider: "github", repository: "example/platform-feedback" } });
  const response = await componentOptions(null, "https://host.example.test/projects/example");
  expect((await response.json()).data.destination).toEqual({ provider: "github", repository: "example/platform-feedback" });
});
