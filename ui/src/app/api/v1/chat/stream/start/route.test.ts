/** @jest-environment node */
import { NextRequest, NextResponse } from "next/server";
import { POST } from "./route";
import { POST as STATUS } from "../status/route";
import { POST as RESUME } from "../resume/route";
import { POST as CANCEL } from "../cancel/route";
import { normalizeLegacyAgenticAppManifest } from "../../../../../../../app-sdk/agentic-app-manifest.mjs";

const mockAuthenticate = jest.fn();
const mockCookieAuth = jest.fn();
const mockAgentPermission = jest.fn();
const mockConversationAccess = jest.fn();
const mockLoadApps = jest.fn();
const mockGetApp = jest.fn();
const mockDynamicStream = jest.fn();
const mockResolveHarness = jest.fn();

jest.mock("@/lib/da-proxy", () => ({
  authenticateRequest: (...args: unknown[]) => mockAuthenticate(...args),
  getDynamicAgentsConfig: () => ({ dynamicAgentsUrl: "http://runtime.example.test" }),
  proxySSEStream: (...args: unknown[]) => mockDynamicStream(...args),
}));
jest.mock("@/lib/harness-gateway", () => ({
  resolveHarnessGatewayTarget: (...args: unknown[]) => mockResolveHarness(...args),
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
  getAgenticAppRoutingSnapshot: () => mockLoadApps(),
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
    client_type: "webui", participants: [{ type: "agent", id: "example-agent" }],
  } });
  mockLoadApps.mockReturnValue([app]);
  mockGetApp.mockReturnValue(app);
  mockDynamicStream.mockResolvedValue(new Response("data: fallback\n\n"));
  mockResolveHarness.mockResolvedValue({ kind: "dynamic_agents", harnessId: "dynamic_agents" });
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
  expect(await response.json()).toMatchObject({ error: "Assistant configuration unavailable" });
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

const operations = [["start", POST], ["resume", RESUME], ["cancel", CANCEL], ["status", STATUS]] as const;

it.each(operations)("requires signed Webex context for app %s", async (operation, handler) => {
  mockConversationAccess.mockResolvedValue({ conversation: {
    client_type: "webex", participants: [{ type: "agent", id: "example-agent" }],
  } });
  const upstream = jest.spyOn(global, "fetch");
  const response = await handler(new NextRequest(`https://host.example.test/api/v1/chat/stream/${operation}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "Hello", agent_id: "example-agent", conversation_id: "example-conversation", resume_data: {} }),
  }));
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: "WEBEX_CONTEXT_REQUIRED" });
  expect(upstream).not.toHaveBeenCalled();
  expect(mockResolveHarness).not.toHaveBeenCalled();
  expect(mockDynamicStream).not.toHaveBeenCalled();
});

it.each(operations)("preserves the resolved caller for app %s without another runtime", async (operation, handler) => {
  const configured = { ...app, manifest: { ...app.manifest, ui: { ...app.manifest.ui, assistant: {
    ...app.manifest.ui.assistant, resumePath: "/api/resume", cancelPath: "/api/cancel", statusPath: "/api/status",
  } } } };
  mockLoadApps.mockReturnValue([configured]);
  mockGetApp.mockReturnValue(configured);
  const body = { message: "Hello", conversation_id: "example-conversation", agent_id: "example-agent", resume_data: {} };
  const contentType = operation === "start" || operation === "resume" ? "text/event-stream" : "application/json";
  const upstream = jest.spyOn(global, "fetch").mockResolvedValue(new Response("{}", { headers: { "content-type": contentType } }));
  const response = await handler(new NextRequest(`https://host.example.test/api/v1/chat/stream/${operation}`, {
    method: "POST", headers: { "Content-Type": "application/json", cookie: "secondary-session=example", "x-caipe-user": "untrusted-user" },
    body: JSON.stringify(body),
  }));
  expect(response.status).toBe(200);
  const headers = new Headers(upstream.mock.calls[0][1]?.headers);
  expect(headers.get("x-caipe-user")).toBe("primary-subject");
  expect(headers.get("authorization")).toBe("Bearer example-user-token");
  expect(headers.get("cookie")).toBeNull();
  expect(JSON.parse(Buffer.from(upstream.mock.calls[0][1]?.body as ArrayBuffer).toString())).toEqual(body);
  expect(mockCookieAuth).not.toHaveBeenCalled();
  expect(mockResolveHarness).not.toHaveBeenCalled();
  expect(mockDynamicStream).not.toHaveBeenCalled();
});

it.each(operations)("denies app %s after agent-use revocation before app lookup", async (operation, handler) => {
  mockAgentPermission.mockResolvedValue(NextResponse.json({ error: "Agent use revoked" }, { status: 403 }));
  const upstream = jest.spyOn(global, "fetch");
  const response = await handler(new NextRequest(`https://host.example.test/api/v1/chat/stream/${operation}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "Hello", agent_id: "example-agent", conversation_id: "example-conversation", resume_data: {} }),
  }));
  expect(response.status).toBe(403);
  expect(mockConversationAccess).not.toHaveBeenCalled();
  expect(mockLoadApps).not.toHaveBeenCalled();
  expect(upstream).not.toHaveBeenCalled();
  expect(mockResolveHarness).not.toHaveBeenCalled();
});

it.each(operations)("rejects service accounts for app %s", async (operation, handler) => {
  mockAuthenticate.mockResolvedValue({ subject: "primary-subject", isServiceAccount: true, authenticatedUser: resolvedIdentity });
  const upstream = jest.spyOn(global, "fetch");
  const response = await handler(new NextRequest(`https://host.example.test/api/v1/chat/stream/${operation}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "Hello", agent_id: "example-agent", conversation_id: "example-conversation", resume_data: {} }),
  }));
  expect(response.status).toBe(403);
  expect(upstream).not.toHaveBeenCalled();
  expect(mockResolveHarness).not.toHaveBeenCalled();
});

describe("app session status", () => {
  it("uses the same resolved identity and declared JSON status route", async () => {
    const bound = { ...app, manifest: { ...app.manifest, ui: { ...app.manifest.ui,
      assistant: { ...app.manifest.ui.assistant, statusPath: "/api/status" } } } };
    mockLoadApps.mockReturnValue([bound]); mockGetApp.mockReturnValue(bound);
    const upstream = jest.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ running: true, turnId: "example-turn" }),
      { headers: { "content-type": "application/json" } }));
    const result = await STATUS(request());
    expect(result.status).toBe(200); expect(await result.json()).toEqual({ running: true, turnId: "example-turn" });
    expect(String(upstream.mock.calls[0][0])).toContain("/api/status");
    expect(new Headers(upstream.mock.calls[0][1]?.headers).get("x-caipe-user")).toBe("primary-subject");
    expect(mockCookieAuth).not.toHaveBeenCalled(); expect(mockDynamicStream).not.toHaveBeenCalled();
  });
  it("returns unsupported without invoking another runtime", async () => {
    const upstream = jest.spyOn(global, "fetch");
    expect((await STATUS(request())).status).toBe(501); expect(upstream).not.toHaveBeenCalled();
    expect(mockDynamicStream).not.toHaveBeenCalled();
  });
  it("enforces conversation authorization before forwarding status", async () => {
    mockConversationAccess.mockResolvedValue({ denial: NextResponse.json({ error: "Denied" }, { status: 403 }) });
    const upstream = jest.spyOn(global, "fetch");
    expect((await STATUS(request())).status).toBe(403); expect(upstream).not.toHaveBeenCalled();
  });
  it("enforces agent use before reading the conversation", async () => {
    mockAgentPermission.mockResolvedValue(NextResponse.json({ error: "Denied" }, { status: 403 }));
    expect((await STATUS(request())).status).toBe(403); expect(mockConversationAccess).not.toHaveBeenCalled();
  });
});
