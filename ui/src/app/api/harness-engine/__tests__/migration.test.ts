/** @jest-environment node */
import { NextRequest, NextResponse } from "next/server";
import { POST } from "../sessions/migrate/route";

let binding: Record<string, unknown>;
const lookup = jest.fn();
const invoke = jest.fn();
const resolve = jest.fn();
const update = jest.fn(async (_filter, change) => { Object.assign(binding, change.$set); for (const key of Object.keys(change.$unset ?? {})) delete binding[key]; });
jest.mock("@/lib/da-proxy", () => ({ authenticateRequest: async () => ({ subject: "test-user" }) }));
jest.mock("@/lib/rbac/openfga-agent-authz", () => ({ requireAgentUsePermission: async () => null }));
jest.mock("@/app/api/v1/chat/_conversation-authz", () => ({ authorizeConversationWriteAccess: async () => ({ conversation: {}, denial: null }), resolveConversationRuntimeId: async () => "example-thread" }));
jest.mock("@/lib/harness-engine-proxy", () => ({ getHarnessEngineConfig: () => ({}), lookupHarnessSession: (...args: unknown[]) => lookup(...args) }));
jest.mock("@/lib/harness-gateway", () => ({ gatewayBindingId: () => "example", invokeHarnessGatewayRun: (...args: unknown[]) => invoke(...args), resolveHarnessGatewayTarget: (...args: unknown[]) => resolve(...args) }));
jest.mock("@/lib/mongodb", () => ({ getCollection: async () => ({ findOne: async () => binding, updateOne: (...args: unknown[]) => update(...args as [unknown, unknown]) }) }));
const request = () => new NextRequest("https://example.test/api/harness-engine/sessions/migrate", { method: "POST", body: JSON.stringify({ agent_id: "example-agent", conversation_id: "example-thread", action: "adopt" }) });

it("retains an ambiguous handoff and recovers it after a BFF restart using the same run key", async () => {
  binding = { _id: "example", transition_id: "original-transition", transition_action: "adopt" };
  invoke.mockResolvedValueOnce(NextResponse.json({ error: "timeout" }, { status: 503 }));
  lookup.mockResolvedValueOnce({ active_run: { run_id: "example-run" } });
  expect((await POST(request())).status).toBe(503);
  expect(binding.transition_id).toBe("original-transition");
  expect(update).not.toHaveBeenCalled();
  invoke.mockResolvedValueOnce(NextResponse.json({ success: true }));
  lookup.mockResolvedValueOnce({ native_thread_id: "native-example", active_run: null });
  expect((await POST(request())).status).toBe(200);
  expect(invoke.mock.calls.map(call => call[0].client_request_id)).toEqual(["original-transition", "original-transition"]);
  expect(binding).toMatchObject({ runtime: "harness_engine", native_thread_id: "native-example" });
  expect(binding.transition_id).toBeUndefined();
  expect(resolve).not.toHaveBeenCalled();
});
