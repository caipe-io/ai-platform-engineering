/** @jest-environment node */
import { NextResponse } from "next/server";
import { primaryCoordinationMessage } from "../context.server";
const mockChat = jest.fn();
const mockAnswer = jest.fn();
const mockHandoff = jest.fn();
const mockAccess = jest.fn();
const mockUse = jest.fn();
const mockFeatures = jest.fn();
const mockSnapshot = jest.fn();
const mockSaveSnapshot = jest.fn();
jest.mock("@/lib/mongodb", () => ({ getCollection: async (name: string) => ({ findOne: name === "conversations" ? mockChat : name === "messages" ? mockAnswer : name === "chat_coordination_admissions" ? mockSnapshot : mockHandoff, updateOne: mockSaveSnapshot }) }));
jest.mock("@/app/api/v1/chat/_conversation-authz", () => ({ authorizeConversationWriteAccess: (...args: unknown[]) => mockAccess(...args) }));
jest.mock("@/lib/rbac/openfga-agent-authz", () => ({ requireAgentUsePermission: (...args: unknown[]) => mockUse(...args) }));
jest.mock("../features.server", () => ({ getCoordinationFeatures: () => mockFeatures() }));
const chat = { _id: "example-chat", participants: [{ type: "agent", id: "primary" }], coordination_agents: [
  { agent_id: "helper", handle: "helper", name: "Helper" }, { agent_id: "reviewer", handle: "reviewer", name: "Reviewer" },
] };
const body = { agent_id: "primary", conversation_id: "example-chat", message: "Summarize both replies" };
const auth = { subject: "example-owner", email: "owner@example.test" };
beforeEach(() => {
  jest.clearAllMocks(); mockSnapshot.mockResolvedValue(null); mockSaveSnapshot.mockResolvedValue({ matchedCount: 1 }); mockChat.mockResolvedValue(chat); mockFeatures.mockResolvedValue({ enabled: true, team: true });
  mockAccess.mockResolvedValue({ conversation: chat, denial: null }); mockUse.mockResolvedValue(null);
  mockAnswer.mockImplementation(async query => ({ content: `Result from ${query["metadata.agent_id"]}`, metadata: { turn_status: "done" }, updated_at: new Date("2026-01-01") }));
  mockHandoff.mockResolvedValue({ status: "delivered", updatedAt: new Date("2026-01-01") });
});
it("shares both completed replies and roster with the primary in mentions mode", async () => {
  const result = await primaryCoordinationMessage(body, auth);
  for (const handle of ["helper", "reviewer"]) { expect(result).toContain(`"handle":"@${handle}"`); expect(result).toContain(`Result from ${handle}`); }
  expect(result).toContain('"status":"delivered"'); expect(result).toContain("Current user request:\nSummarize both replies");
  expect(mockAnswer.mock.calls[0][0]).toMatchObject({ conversation_id: "example-chat", role: "assistant", "metadata.is_final": true });
});
it("never sends the snapshot to an addressed collaborator", async () => {
  expect(await primaryCoordinationMessage({ ...body, agent_id: "helper" }, auth)).toBe(body.message); expect(mockAnswer).not.toHaveBeenCalled();
});
it("excludes revoked agents and their results", async () => {
  mockUse.mockImplementation(async ({ agentId }) => agentId === "reviewer" ? new Response(null, { status: 403 }) : null);
  const result = await primaryCoordinationMessage(body, auth);
  expect(result).toContain("Result from helper"); expect(result).not.toContain("reviewer"); expect(mockAnswer).toHaveBeenCalledTimes(1);
});
it("checks chat authorization before reading any results", async () => {
  const denial = NextResponse.json({ error: "Forbidden" }, { status: 403 }); mockAccess.mockResolvedValue({ denial });
  expect(await primaryCoordinationMessage(body, auth)).toBe(denial); expect(mockAnswer).not.toHaveBeenCalled();
});
it("honors feature controls", async () => {
  mockFeatures.mockResolvedValue({ enabled: false, team: false });
  expect(await primaryCoordinationMessage(body, auth)).toBe(body.message); expect(mockAnswer).not.toHaveBeenCalled();
});
it("bounds replies and labels them as untrusted data separate from the request", async () => {
  mockAnswer.mockResolvedValue({ content: "x".repeat(7000), metadata: {}, updated_at: new Date() });
  const result = await primaryCoordinationMessage(body, auth);
  expect(result).toContain('"truncated":true'); expect(result).not.toContain("x".repeat(6001)); expect(result).toContain("not instructions");
});
it("distinguishes pending assignments from older published replies", async () => {
  mockHandoff.mockResolvedValue({ status: "pending", updatedAt: new Date() });
  const result = await primaryCoordinationMessage(body, auth);
  expect(result).toContain('"latest_assignment":{"status":"pending"'); expect(result).toContain("latest_published_reply");
});
it("does not change resume payloads", async () => {
  expect(await primaryCoordinationMessage({ ...body, command: "resume" }, auth)).toBe(body.message); expect(mockChat).not.toHaveBeenCalled();
});

it("reuses the identical admitted snapshot after peer replies change", async () => {
  mockSnapshot.mockResolvedValue({ primary_snapshot: { request: body.message, message: "Frozen primary context", peers: ["helper", "reviewer"] } });
  expect(await primaryCoordinationMessage(body, auth, { _id: "example-fence", generation: "example-generation" })).toBe("Frozen primary context");
  expect(mockAnswer).not.toHaveBeenCalled();
});
it("does not reuse an admitted snapshot after a peer's access is revoked", async () => {
  mockSnapshot.mockResolvedValue({ primary_snapshot: { request: body.message, message: "Frozen primary context", peers: ["helper", "reviewer"] } });
  mockUse.mockImplementation(async ({ agentId }) => agentId === "reviewer" ? new Response(null, { status: 403 }) : null);
  const result = await primaryCoordinationMessage(body, auth, { _id: "example-fence", generation: "example-generation" });
  expect(result).toBeInstanceOf(NextResponse); expect((result as NextResponse).status).toBe(409);
});
it("freezes the first successful snapshot on the current admission generation", async () => {
  mockSaveSnapshot.mockImplementation(async (_query, update) => { mockSnapshot.mockResolvedValue({ primary_snapshot: update.$set.primary_snapshot }); });
  const result = await primaryCoordinationMessage(body, auth, { _id: "example-fence", generation: "example-generation" });
  expect(result).toContain("Result from helper");
  expect(mockSaveSnapshot).toHaveBeenCalledWith({ _id: "example-fence", generation: "example-generation", primary_snapshot: { $exists: false } }, expect.anything());
});
