/** @jest-environment node */
import { NextResponse } from "next/server";
import { resolveHarnessNativeNamespace } from "../harness-native-state";

const authorize = jest.fn();
const workflow = jest.fn();
const workflowAccess = jest.fn();
const pinned = jest.fn();
jest.mock("@/app/api/v1/chat/_conversation-authz", () => ({ authorizeConversationReadAccess: (...args: unknown[]) => authorize(...args), authorizeConversationWriteAccess: (...args: unknown[]) => authorize(...args) }));
jest.mock("@/lib/mongodb", () => ({ getCollection: async () => ({ findOne: (...args: unknown[]) => workflow(...args) }) }));
jest.mock("@/lib/server/workflow-cas-authz", () => ({ requireWorkflowRunAccess: (...args: unknown[]) => workflowAccess(...args) }));
jest.mock("@/lib/harness-gateway", () => ({ getPinnedHarnessGatewayTarget: (...args: unknown[]) => pinned(...args), getHarnessGatewayNativeThread: async () => "example-thread" }));
const raw = JSON.stringify(["example-agent", "example-thread", "filesystem"]);

beforeEach(() => { jest.resetAllMocks(); workflow.mockResolvedValue(null); authorize.mockResolvedValue({ denial: null }); pinned.mockResolvedValue(null); });

it("authorizes unbound native namespaces before forwarding them", async () => {
  authorize.mockResolvedValue({ denial: NextResponse.json({ error: "denied" }, { status: 403 }) });
  expect((await resolveHarnessNativeNamespace(raw, { subject: "other-user" }) as NextResponse).status).toBe(403);
  expect(pinned).not.toHaveBeenCalled();
});

it("preserves an authorized workflow namespace through the existing workflow adapter", async () => {
  workflow.mockResolvedValue({ _id: "example-thread", workflow_config_id: "example-agent" });
  expect(await resolveHarnessNativeNamespace(raw, { subject: "test-user" }, true)).toBe(raw);
  expect(workflowAccess).toHaveBeenCalledWith({ sub: "test-user", isServiceAccount: undefined }, expect.anything(), "write");
  expect(authorize).not.toHaveBeenCalled();
});

it("rejects file operations during a handoff", async () => {
  pinned.mockResolvedValue(NextResponse.json({ error: "handoff" }, { status: 409 }));
  expect((await resolveHarnessNativeNamespace(raw, { subject: "test-user" }) as NextResponse).status).toBe(409);
});
