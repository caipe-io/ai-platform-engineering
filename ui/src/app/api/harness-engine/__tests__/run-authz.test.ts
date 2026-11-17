/** @jest-environment node */
import { NextRequest, NextResponse } from "next/server";
const mockAuthenticate = jest.fn();
const mockProxy = jest.fn();
const mockAgentPermission = jest.fn();
const mockConversation = jest.fn();
jest.mock("@/lib/da-proxy", () => ({ authenticateRequest: (...args: unknown[]) => mockAuthenticate(...args) }));
jest.mock("@/lib/harness-engine-proxy", () => ({
  getHarnessEngineConfig: () => ({}), proxyHarnessEngine: (...args: unknown[]) => mockProxy(...args),
  harnessConversationReadHeaders: () => ({}),
}));
jest.mock("@/lib/rbac/openfga-agent-authz", () => ({ requireAgentUsePermission: (...args: unknown[]) => mockAgentPermission(...args) }));
jest.mock("@/lib/rbac/authz-tracing", () => ({ createAuthzTraceContext: () => ({ traceparent: "test-trace" }) }));
jest.mock("@/app/api/v1/chat/_conversation-authz", () => ({
  authorizeConversationReadAccess: (...args: unknown[]) => mockConversation(...args),
  authorizeConversationWriteAccess: (...args: unknown[]) => mockConversation(...args),
}));
import { authorizeHarnessRunAccess } from "../_run-authz";
const child = { run_id: "run-child", owner_subject: "test-user", agent_id: "child", conversation_id: "private-child-session", parent_run_id: "run-parent" };
const parent = { run_id: "run-parent", owner_subject: "test-user", agent_id: "parent", conversation_id: "parent-chat", harness_id: "dynamic_agents", status: "running" };
beforeEach(() => {
  jest.resetAllMocks();
  mockAuthenticate.mockResolvedValue({ subject: "test-user" });
  mockAgentPermission.mockResolvedValue(null);
  mockConversation.mockResolvedValue({ denial: null });
  mockProxy.mockImplementation(async (_config, _auth, path) => Response.json({ success: true, data: path.endsWith("run-child") ? child : parent }));
});
it("binds child authorization to its attested parent chat while retaining the child run", async () => {
  const access = await authorizeHarnessRunAccess(new NextRequest("https://example.test/api/harness-engine/runs/run-child/tools?parent_run_id=forged"), "run-child", "write");
  expect(access).not.toBeInstanceOf(NextResponse);
  if (access instanceof NextResponse) throw new Error("Denied");
  expect((await access.response.json()).data.agent_id).toBe("child");
  expect(mockConversation).toHaveBeenCalledWith(expect.anything(), "parent-chat", "parent");
  expect(mockAgentPermission.mock.calls.map(([args]) => args.agentId)).toEqual(["child", "parent"]);
  expect(access.delegationParent?.status).toBe("running");
});
it.each([
  { ...parent, owner_subject: "other-user" },
  { ...parent, harness_id: "claude_code_cli_acp" },
  { ...parent, parent_run_id: "nested-parent" },
])("rejects invalid parent lineage", async invalid => {
  mockProxy.mockImplementation(async (_config, _auth, path) => Response.json({ success: true, data: path.endsWith("run-child") ? child : invalid }));
  const access = await authorizeHarnessRunAccess(new NextRequest("https://example.test/api/harness-engine/runs/run-child/tools"), "run-child", "write");
  expect(access).toBeInstanceOf(NextResponse);
  expect((access as NextResponse).status).toBe(403);
  expect(mockConversation).not.toHaveBeenCalled();
});
it("honors revoked parent chat permission", async () => {
  mockConversation.mockResolvedValue({ denial: NextResponse.json({ error: "Forbidden" }, { status: 403 }) });
  const access = await authorizeHarnessRunAccess(new NextRequest("https://example.test/api/harness-engine/runs/run-child/tools"), "run-child", "write");
  expect((access as NextResponse).status).toBe(403);
});
