/** @jest-environment node */
import { NextRequest, NextResponse } from "next/server";
import { POST } from "../route";
import { normalizeLegacyAgenticAppManifest } from "../../../../../../../app-sdk/agentic-app-manifest.mjs";

const mockAuthenticate = jest.fn();
const mockAgentPermission = jest.fn();
const mockConversationAccess = jest.fn();
const mockLoadApps = jest.fn();
const mockGetApp = jest.fn();
const mockFindMessage = jest.fn();
const mockAuditWrite = jest.fn();

jest.mock("@/lib/da-proxy", () => ({ authenticateRequest: (...args: unknown[]) => mockAuthenticate(...args) }));
jest.mock("@/lib/api-middleware", () => ({ ApiError: class extends Error {}, getAuthenticatedUser: jest.fn() }));
jest.mock("@/lib/rbac/openfga-agent-authz", () => ({
  requireAgentUsePermission: (...args: unknown[]) => mockAgentPermission(...args),
}));
jest.mock("../../_conversation-authz", () => ({
  authorizeConversationWriteAccess: (...args: unknown[]) => mockConversationAccess(...args),
}));
jest.mock("@/lib/agentic-apps/config", () => ({
  isAgenticAppsEnabled: () => true,
  getAgenticAppRoutingSnapshot: () => mockLoadApps(),
  getConfiguredAgenticApp: () => mockGetApp(),
}));
jest.mock("@/lib/mongodb", () => ({
  getCollection: async () => ({ findOne: (...args: unknown[]) => mockFindMessage(...args) }),
}));
jest.mock("@/lib/audit", () => ({ getAuditBackend: () => ({ write: (...args: unknown[]) => mockAuditWrite(...args) }) }));

const dialogAction = {
  id: "flag-answer", label: "Flag answer", icon: "flag", path: "/api/example/actions/flag",
  dialog: {
    title: "Flag this answer", submitLabel: "Submit",
    field: { label: "Corrected answer", prefill: "message", optional: false, maxLength: 20 },
  },
};
const plainAction = { id: "mark", label: "Mark", icon: "check", path: "/api/example/actions/mark" };
const app = {
  manifest: {
    ...normalizeLegacyAgenticAppManifest({
      id: "example-app", auth: { mode: "forward-user-access-token" },
      runtime: { kind: "proxied-next-zone", mountPath: "/apps/example-app", origin: "http://app.example.test" },
      access: { requiredRoles: ["user"], tokenScopes: [], policyActions: [{ action: "proxy:POST", defaultEffect: "allow" }] },
    }),
    ui: { profiles: [{ id: "hosted", mode: "iframe" }], routes: [], assistant: {
      agentId: "example-agent", label: "Ask Example", name: "Example", streamPath: "/api/example/chat",
      hostOptions: { version: "1.0", messageActions: [dialogAction, plainAction] },
    } },
  },
  installation: { appId: "example-app", installed: true, enabled: true },
};
const identity = {
  user: { email: "primary@example.test", name: "Primary", role: "user" },
  session: { sub: "primary-subject", role: "user", accessToken: "example-user-token" },
};
const conversation = { _id: "example-conversation", client_type: "webui", participants: [{ type: "agent", id: "example-agent" }] };
const valid = {
  conversation_id: "example-conversation", agent_id: "example-agent", message_id: "example-message",
  action_id: "flag-answer", input: { text: "Corrected text" },
};

function call(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return POST(new NextRequest("https://host.example.test/api/v1/chat/assistant-actions?x=1", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: "secondary-session=example", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}
function appReply(status: number, body: unknown, contentType = "application/json"): jest.SpyInstance {
  return jest.spyOn(global, "fetch").mockResolvedValue(new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status, headers: { "content-type": contentType },
  }));
}

/** The proxy forwards the body as bytes. */
function sentBody(fetchSpy: jest.SpyInstance): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(fetchSpy.mock.calls[0][1]?.body as ArrayBuffer));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthenticate.mockResolvedValue({ subject: "primary-subject", email: "primary@example.test", authenticatedUser: identity });
  mockAgentPermission.mockResolvedValue(null);
  mockConversationAccess.mockResolvedValue({ conversation, denial: null });
  mockLoadApps.mockReturnValue([app]);
  mockGetApp.mockReturnValue(app);
  mockFindMessage.mockResolvedValue({ message_id: "example-message", role: "assistant", metadata: { turn_id: "stored-turn" } });
});
afterEach(() => jest.restoreAllMocks());

describe("caller checks", () => {
  it("rejects an unauthenticated caller", async () => {
    mockAuthenticate.mockResolvedValue(NextResponse.json({ error: "Unauthorized" }, { status: 401 }));
    const fetchSpy = appReply(200, {});
    expect((await call(valid)).status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a service account", async () => {
    mockAuthenticate.mockResolvedValue({ subject: "automation", isServiceAccount: true, authenticatedUser: identity });
    const fetchSpy = appReply(200, {});
    expect((await call(valid)).status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a caller who may not use the agent", async () => {
    mockAgentPermission.mockResolvedValue(NextResponse.json({ error: "Forbidden" }, { status: 403 }));
    const fetchSpy = appReply(200, {});
    expect((await call(valid)).status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([403, 404])("returns the conversation denial (%i) for a non-owner", async (status) => {
    mockConversationAccess.mockResolvedValue({ conversation: null, denial: NextResponse.json({ error: "No" }, { status }) });
    const fetchSpy = appReply(200, {});
    expect((await call(valid)).status).toBe(status);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("request validation", () => {
  it.each([
    ["malformed JSON", "{"],
    ["a missing action id", { ...valid, action_id: undefined }],
    ["a non-string message id", { ...valid, message_id: 7 }],
    ["a non-object input", { ...valid, input: "text" }],
    ["a non-string text", { ...valid, input: { text: 5 } }],
  ])("rejects %s", async (_name, body) => {
    const fetchSpy = appReply(200, {});
    expect((await call(body)).status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects an oversize body", async () => {
    const fetchSpy = appReply(200, {});
    expect((await call({ ...valid, input: { text: "x".repeat(300_000) } })).status).toBe(413);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects text over the declared limit and an empty required field", async () => {
    const fetchSpy = appReply(200, {});
    expect((await call({ ...valid, input: { text: "x".repeat(21) } })).status).toBe(400);
    expect((await call({ ...valid, input: { text: "  " } })).status).toBe(400);
    expect((await call({ ...valid, input: undefined })).status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("resolution", () => {
  it("rejects an undeclared action", async () => {
    const fetchSpy = appReply(200, {});
    const response = await call({ ...valid, action_id: "other" });
    expect(response.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ignores a client-supplied path, app and turn", async () => {
    const fetchSpy = appReply(200, { ok: true });
    await call({ ...valid, path: "/api/evil", app_id: "other-app", turn_id: "forged-turn" });
    const url = String(fetchSpy.mock.calls[0][0]);
    expect(url).toBe("http://app.example.test/api/example/actions/flag");
    expect(sentBody(fetchSpy).turn_id).toBe("stored-turn");
  });

  it("rejects an agent that differs from the conversation", async () => {
    const fetchSpy = appReply(200, {});
    const response = await call({ ...valid, agent_id: "other-agent" });
    expect(response.status).toBe(409);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a conversation from another client", async () => {
    mockConversationAccess.mockResolvedValue({ conversation: { ...conversation, client_type: "webex" }, denial: null });
    const fetchSpy = appReply(200, {});
    expect((await call(valid)).status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("maps conflicting app bindings to a controlled unavailable response", async () => {
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    mockLoadApps.mockReturnValue([app, app]);
    const response = await call(valid);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "ASSISTANT_UNAVAILABLE" });
  });

  it("refuses a disabled app", async () => {
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    mockLoadApps.mockReturnValue([{ ...app, installation: { ...app.installation, enabled: false } }]);
    expect((await call(valid)).status).toBe(503);
  });
});

describe("message checks", () => {
  it("looks the message up inside the authorized conversation", async () => {
    appReply(200, {});
    await call(valid);
    expect(mockFindMessage).toHaveBeenCalledWith({ conversation_id: "example-conversation", message_id: "example-message" });
  });

  it.each([
    ["missing", null, 404],
    ["a user message", { role: "user", metadata: { turn_id: "t" } }, 409],
    ["a message without a turn", { role: "assistant", metadata: {} }, 409],
  ])("rejects %s", async (_name, stored, status) => {
    mockFindMessage.mockResolvedValue(stored);
    const fetchSpy = appReply(200, {});
    expect((await call(valid)).status).toBe(status);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("calling the app", () => {
  it("forwards the declared body as the user without browser credentials", async () => {
    const fetchSpy = appReply(200, { message: "Saved" });
    const response = await call(valid);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: { message: "Saved" } });
    expect(sentBody(fetchSpy)).toEqual({
      conversation_id: "example-conversation", message_id: "example-message", turn_id: "stored-turn",
      action_id: "flag-answer", text: "Corrected text",
    });
    const init = fetchSpy.mock.calls[0][1];
    const headers = new Headers(init?.headers);
    expect(fetchSpy.mock.calls[0][0].toString()).not.toContain("x=1");
    expect(headers.get("x-caipe-user")).toBe("primary-subject");
    expect(headers.get("authorization")).toBe("Bearer example-user-token");
    expect(headers.get("cookie")).toBeNull();
    expect(init?.redirect).toBe("manual");
  });

  it("omits text for an action without a dialog", async () => {
    const fetchSpy = appReply(200, { ok: true });
    await call({ ...valid, action_id: "mark" });
    expect(sentBody(fetchSpy)).not.toHaveProperty("text");
  });

  it("maps the app's error and code", async () => {
    appReply(422, { error: "Already recorded", code: "ALREADY_DONE", detail: "internal" });
    const response = await call(valid);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ success: false, error: "Already recorded", code: "ALREADY_DONE" });
  });

  it("does not pass the app's 401 or 5xx through", async () => {
    appReply(401, { error: "Token expired" });
    expect((await call(valid)).status).toBe(502);
    appReply(500, { error: "Boom" });
    expect((await call(valid)).status).toBe(502);
  });

  it("rejects a non-JSON response", async () => {
    appReply(200, "<html>", "text/html");
    const response = await call(valid);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: "ASSISTANT_ACTION_BAD_RESPONSE" });
  });

  it("does not follow a redirect", async () => {
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(new Response(null, {
      status: 302, headers: { location: "https://other.example.test/x" },
    }));
    const response = await call(valid);
    expect(response.status).toBe(502);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("reports an unreachable app without internal detail", async () => {
    jest.spyOn(global, "fetch").mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.1"));
    const response = await call(valid);
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).toContain("ASSISTANT_ACTION_UNAVAILABLE");
    expect(text).not.toContain("10.0.0.1");
  });

  it("times out", async () => {
    jest.spyOn(AbortSignal, "timeout").mockImplementation(() => AbortSignal.abort());
    jest.spyOn(global, "fetch").mockRejectedValue(new Error("aborted"));
    const response = await call(valid);
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ code: "ASSISTANT_ACTION_TIMEOUT" });
  });
});

describe("audit", () => {
  it("records the app and action but never the text", async () => {
    appReply(200, { ok: true });
    await call(valid);
    expect(mockAuditWrite).toHaveBeenCalledTimes(1);
    const event = mockAuditWrite.mock.calls[0][0];
    expect(event).toMatchObject({
      action: "assistant.message_action", outcome: "success", resource_ref: "app:example-app/action:flag-answer",
    });
    expect(JSON.stringify(event)).not.toContain("Corrected text");
    expect(JSON.stringify(event)).not.toContain("primary-subject");
  });

  it("records a failed call", async () => {
    appReply(400, { error: "No" });
    await call(valid);
    expect(mockAuditWrite.mock.calls[0][0]).toMatchObject({ outcome: "error", reason_code: "APP_ERROR" });
  });

  it("writes nothing for a refused request", async () => {
    await call({ ...valid, action_id: "other" });
    expect(mockAuditWrite).not.toHaveBeenCalled();
  });
});
