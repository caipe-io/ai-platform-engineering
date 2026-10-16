/** @jest-environment node */
import { NextRequest } from "next/server";
import { POST } from "./route";
import { normalizeLegacyAgenticAppManifest } from "../../../../../../../app-sdk/agentic-app-manifest.mjs";

const mockAuthenticate = jest.fn();
const mockCookieAuth = jest.fn();
const mockAgentPermission = jest.fn();
const mockConversationAccess = jest.fn();
const mockLoadApps = jest.fn();
const mockGetApp = jest.fn();
const mockDynamicStream = jest.fn();

jest.mock("@/lib/da-proxy", () => ({
  authenticateRequest: (...args: unknown[]) => mockAuthenticate(...args),
  getDynamicAgentsConfig: () => ({ dynamicAgentsUrl: "http://runtime.example.test" }),
  proxySSEStream: (...args: unknown[]) => mockDynamicStream(...args),
}));
jest.mock("@/lib/api-middleware", () => ({
  ApiError: class extends Error {},
  getAuthenticatedUser: (...args: unknown[]) => mockCookieAuth(...args),
}));
jest.mock("@/lib/rbac/openfga-agent-authz", () => ({
  requireAgentUsePermission: (...args: unknown[]) => mockAgentPermission(...args),
}));
jest.mock("../../_conversation-authz", () => ({
  authorizeConversationWriteAccess: (...args: unknown[]) => mockConversationAccess(...args),
  resolveConversationRuntimeId: async () => "example-conversation",
}));
jest.mock("@/lib/agentic-apps/config", () => ({
  isAgenticAppsEnabled: () => true,
  loadConfiguredAgenticApps: () => mockLoadApps(),
  getConfiguredAgenticApp: () => mockGetApp(),
}));

const app = {
  manifest: {
    ...normalizeLegacyAgenticAppManifest({
      id: "example-app", auth: { mode: "forward-user-access-token" },
      runtime: { kind: "proxied-next-zone", mountPath: "/apps/example-app", origin: "http://app.example.test" },
      access: { requiredRoles: ["user"], tokenScopes: [], policyActions: [{ action: "proxy:POST", defaultEffect: "allow" }] },
    }),
    ui: { profiles: [{ id: "hosted", mode: "iframe" }], routes: [], assistant: {
      agentId: "example-agent", label: "Ask Example", name: "Example", streamPath: "/api/stream",
    } },
  },
  installation: { appId: "example-app", installed: true, enabled: true },
};
const resolvedIdentity = {
  user: { email: "primary@example.test", name: "Primary", role: "user" },
  session: { sub: "primary-subject", role: "user", accessToken: "example-user-token" },
};
const request = () => new NextRequest("https://host.example.test/api/v1/chat/stream/start", {
  method: "POST", headers: { "content-type": "application/json", cookie: "secondary-session=example" },
  body: JSON.stringify({ message: "Hello", conversation_id: "example-conversation", agent_id: "example-agent" }),
});

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthenticate.mockResolvedValue({ subject: "primary-subject", authenticatedUser: resolvedIdentity });
  mockCookieAuth.mockResolvedValue({ user: { role: "admin" }, session: { sub: "secondary-subject" } });
  mockAgentPermission.mockResolvedValue(null);
  mockConversationAccess.mockResolvedValue({ conversation: {
    client_type: "webex", participants: [{ type: "agent", id: "example-agent" }],
  } });
  mockLoadApps.mockReturnValue([app]);
  mockGetApp.mockReturnValue(app);
  mockDynamicStream.mockResolvedValue(new Response("data: fallback\n\n"));
});
afterEach(() => jest.restoreAllMocks());

it.each(["text/event-stream", "Text/Event-Stream; charset=utf-8"])("uses the resolved bearer identity with SSE %s", async (contentType) => {
  const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(new Response("data: result\n\n", {
    headers: { "content-type": contentType },
  }));
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("result");
  expect(mockCookieAuth).not.toHaveBeenCalled();
  const headers = new Headers(fetchSpy.mock.calls[0][1]?.headers);
  expect(headers.get("x-caipe-user")).toBe("primary-subject");
  expect(headers.get("authorization")).toBe("Bearer example-user-token");
  expect(headers.get("cookie")).toBeNull();
  expect(response.headers.get("x-accel-buffering")).toBe("no");
});

it("maps conflicting bindings to a controlled unavailable response", async () => {
  mockLoadApps.mockReturnValue([app, app]);
  const response = await POST(request());
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: "Assistant configuration conflict" });
});

it("rejects a non-SSE success", async () => {
  jest.spyOn(global, "fetch").mockResolvedValue(new Response("{}", { headers: { "content-type": "application/json" } }));
  expect((await POST(request())).status).toBe(502);
});

it("retains app launch denial for the resolved identity", async () => {
  mockGetApp.mockReturnValue({ ...app, manifest: { ...app.manifest, access: { ...app.manifest.access, requiredRoles: ["admin"] } } });
  expect((await POST(request())).status).toBe(403);
});

it("rejects service-account forwarding", async () => {
  mockAuthenticate.mockResolvedValue({ subject: "primary-subject", isServiceAccount: true, authenticatedUser: resolvedIdentity });
  expect((await POST(request())).status).toBe(403);
});

it("uses Dynamic Agents when no installed app claims the assistant", async () => {
  mockLoadApps.mockReturnValue([]);
  await POST(request());
  expect(mockDynamicStream).toHaveBeenCalledTimes(1);
});
