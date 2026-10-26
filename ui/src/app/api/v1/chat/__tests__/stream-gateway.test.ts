/** @jest-environment node */
import { NextResponse } from "next/server";
import type { Conversation } from "@/types/mongodb";
import { dispatchChatStream } from "../_stream-gateway";

const resolve = jest.fn();
const app = jest.fn();
const nativeStream = jest.fn();
const nativeJSON = jest.fn();
const config = jest.fn();
const engineStream = jest.fn();
const engineCancel = jest.fn();

jest.mock("@/lib/agentic-apps/assistant-stream", () => ({
  ...jest.requireActual("@/lib/agentic-apps/assistant-stream"),
  proxyAgenticAppAssistantStream: (...args: unknown[]) => app(...args),
}));
jest.mock("@/lib/harness-gateway", () => ({
  resolveHarnessGatewayTarget: (...args: unknown[]) => resolve(...args),
  streamHarnessGatewayRun: (...args: unknown[]) => engineStream(...args),
  cancelHarnessGatewayRun: (...args: unknown[]) => engineCancel(...args),
  unsupportedHarnessResume: () => NextResponse.json({ error: "Unsupported" }, { status: 409 }),
  withHarnessGatewayTarget: (response: Response) => response,
}));
jest.mock("@/lib/da-proxy", () => ({
  getDynamicAgentsConfig: () => config(),
  proxySSEStream: (...args: unknown[]) => nativeStream(...args),
  proxyJSONRequest: (...args: unknown[]) => nativeJSON(...args),
}));
jest.mock("../_conversation-authz", () => ({
  resolveConversationRuntimeId: async () => "runtime-example",
}));

const conversation = { _id: "visible-example" } as Conversation;
const body = { agent_id: "agent-example", conversation_id: conversation._id, message: "Inspect" };
const auth = { subject: "caller-example" };
const request = () => new Request("https://host.example.test/api/v1/chat/stream/start", { method: "POST" });

beforeEach(() => {
  jest.clearAllMocks();
  app.mockResolvedValue(null);
  config.mockReturnValue({ dynamicAgentsUrl: "http://native.example.test" });
  for (const proxy of [nativeStream, nativeJSON, engineStream, engineCancel]) {
    proxy.mockImplementation(async () => new Response("accepted"));
  }
});

it.each(["start", "resume", "cancel", "status"] as const)(
  "keeps a pinned provider ahead of a new app claim for %s", async (operation) => {
    resolve.mockResolvedValue({ kind: "harness_engine", harnessId: "agentcore" });
    app.mockResolvedValue(new Response("wrong app"));
    const response = await dispatchChatStream(request(), auth, conversation, body, operation);
    expect(app).not.toHaveBeenCalled();
    expect(config).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledWith("agent-example", { conversationId: "runtime-example", retainedOnly: true });
    if (operation === "start") expect(engineStream).toHaveBeenCalledWith(
      expect.objectContaining({ conversation_id: "runtime-example", expected_harness_id: "agentcore" }), auth, expect.anything(),
    );
    if (operation === "cancel") expect(engineCancel).toHaveBeenCalledWith(
      expect.objectContaining({ conversation_id: "runtime-example" }), auth,
    );
    expect(response.status).toBe(operation === "resume" ? 409 : operation === "status" ? 501 : 200);
  },
);

it.each(["start", "resume", "cancel"] as const)(
  "keeps a retained native context ahead of a new app claim for %s", async (operation) => {
    resolve.mockResolvedValue({ kind: "dynamic_agents", harnessId: "dynamic_agents" });
    app.mockResolvedValue(new Response("wrong app"));
    await dispatchChatStream(request(), auth, conversation, body, operation);
    expect(app).not.toHaveBeenCalled();
    const proxy = operation === "cancel" ? nativeJSON : nativeStream;
    expect(proxy).toHaveBeenCalledWith(
      `http://native.example.test/api/v1/chat/stream/${operation}`,
      JSON.stringify({ ...body, conversation_id: "runtime-example" }), auth, `[stream/${operation}]`,
    );
  },
);

it("passes an unbound app its visible ID without admitting native/provider state", async () => {
  resolve.mockResolvedValue(null);
  const response = new Response("app stream");
  app.mockResolvedValue(response);
  expect(await dispatchChatStream(request(), auth, conversation, body, "start")).toBe(response);
  expect(app).toHaveBeenCalledWith(expect.any(Request), auth, conversation, body, "start");
  expect(resolve).toHaveBeenCalledTimes(1);
  expect(config).not.toHaveBeenCalled();
});

it("does not hide retained owner conflicts behind an app", async () => {
  const conflict = NextResponse.json({ error: "Binding conflict" }, { status: 409 });
  resolve.mockResolvedValue(conflict);
  expect(await dispatchChatStream(request(), auth, conversation, body, "cancel")).toBe(conflict);
  expect(app).not.toHaveBeenCalled();
  expect(engineCancel).not.toHaveBeenCalled();
});

it("admits the ordinary configured backend only after no retained owner or app matches", async () => {
  resolve.mockResolvedValueOnce(null).mockResolvedValueOnce({ kind: "harness_engine", harnessId: "agentcore" });
  await dispatchChatStream(request(), auth, conversation, body, "start");
  expect(resolve).toHaveBeenNthCalledWith(2, "agent-example", { conversationId: "runtime-example", admit: true });
  expect(engineStream).toHaveBeenCalledTimes(1);
});


it("rejects contradictory retained app and native ownership instead of choosing either", async () => {
  resolve.mockResolvedValue({ kind: "dynamic_agents", harnessId: "dynamic_agents" });
  const response = await dispatchChatStream(request(), auth, {
    ...conversation, app_binding: { app_id: "example-app", agent_id: "agent-example" },
  }, body, "start");
  expect(response.status).toBe(409);
  expect(app).not.toHaveBeenCalled();
  expect(nativeStream).not.toHaveBeenCalled();
});

it.each(["dynamic_agents", "agentcore", "claude_agent_sdk"])(
  "preserves retained %s execution for a metadata-only overlay", async (harnessId) => {
    resolve.mockResolvedValue({ kind: harnessId === "dynamic_agents" ? "dynamic_agents" : "harness_engine", harnessId });
    const response = await dispatchChatStream(request(), auth, {
      ...conversation, participants: [{ type: "agent", id: "agent-example" }], metadata: {
        conversation_surface: "agentic-app", agentic_app_id: "example-app", agentic_app_agent_id: "agent-example",
      },
    }, body, "start");
    expect(response.status).toBe(200);
    expect(app).not.toHaveBeenCalled();
    expect(harnessId === "dynamic_agents" ? nativeStream : engineStream).toHaveBeenCalledTimes(1);
  },
);
