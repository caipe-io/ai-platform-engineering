/** @jest-environment node */
import { NextResponse } from "next/server";
import { resolveAppConversationDestination, admitAppConversation } from "../app-assistant-binding";
import { hasStoredAppConversationIdentity, matchesAppConversation } from "../app-conversation-binding";
import type { Conversation } from "@/types/mongodb";

const mockUpdate = jest.fn();
const mockFind = jest.fn();
jest.mock("@/lib/mongodb", () => ({ getCollection: jest.fn(async () => ({ findOneAndUpdate: mockUpdate, findOne: mockFind })) }));
const target = { appId: "example-app", path: ["api", "example", "start"] };
const chat = { _id: "example-chat", participants: [{ type: "agent", id: "example-agent" }] } as Conversation;
const presentation = { conversation_surface: "agentic-app", agentic_app_id: "example-app", agentic_app_agent_id: "example-agent" };
const stream = (id: string) => id === "example-agent" ? target : null;
beforeEach(() => jest.clearAllMocks());

it("does not treat SDK overlay presentation metadata as execution ownership", () => {
  const sdk = { ...chat, metadata: presentation };
  expect(resolveAppConversationDestination(sdk, "example-agent", "start", () => null)).toBeNull();
  expect(resolveAppConversationDestination(sdk, "example-agent", "start", stream, true)).toBeNull();
  expect(hasStoredAppConversationIdentity(sdk)).toBe(false);
  expect(matchesAppConversation(sdk, "another-app", "example-agent")).toBe(true);
});
it("resolves an unbound declared app without trusting context labels", () => {
  expect(resolveAppConversationDestination({ ...chat, metadata: presentation }, "example-agent", "start", stream)).toEqual(target);
  expect(matchesAppConversation(chat, "example-app", "another-agent")).toBe(false);
});
it.each(["removed", "rebound", "retained", "malformed"])("fences authoritative app ownership when %s", variant => {
  const bound = { ...chat, app_binding: variant === "malformed" ? null : { app_id: "example-app", agent_id: "example-agent" } } as Conversation;
  const find = variant === "removed" ? () => null : variant === "rebound" ? () => ({ ...target, appId: "another-app" }) : stream;
  const result = resolveAppConversationDestination(bound, "example-agent", "start", find, variant === "retained");
  expect(result).toBeInstanceOf(NextResponse);
  expect((result as NextResponse).status).toBe(409);
});
it("rejects a request agent that differs from the canonical participant", () => {
  expect((resolveAppConversationDestination(chat, "another-agent", "start", stream) as NextResponse).status).toBe(409);
});
it("fails closed when the declared stream configuration is unavailable", () => {
  expect((resolveAppConversationDestination(chat, "example-agent", "start", () => { throw new Error("offline"); }) as NextResponse).status).toBe(503);
});
it("atomically admits ownership and permits only the same concurrent winner", async () => {
  mockUpdate.mockResolvedValueOnce({ ...chat, app_binding: { app_id: "example-app", agent_id: "example-agent" } });
  expect(await admitAppConversation(chat, target, stream)).toBeNull();
  expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ _id: "example-chat", app_binding: { $exists: false },
    participants: { $elemMatch: { type: "agent", id: "example-agent" } } }),
    { $set: { app_binding: { app_id: "example-app", agent_id: "example-agent" } } }, { returnDocument: "after" });
  mockUpdate.mockResolvedValue(null);
  mockFind.mockResolvedValue({ ...chat, app_binding: { app_id: "example-app", agent_id: "example-agent" } });
  expect(await admitAppConversation(chat, target, stream)).toBeNull();
  mockFind.mockResolvedValue({ ...chat, app_binding: { app_id: "other-app", agent_id: "example-agent" } });
  expect((await admitAppConversation(chat, target, stream))?.status).toBe(409);
});
it("does not continue when app admission cannot be persisted", async () => {
  mockUpdate.mockRejectedValue(new Error("database unavailable"));
  expect((await admitAppConversation(chat, target, stream))?.status).toBe(503);
});

it.each(["deleted", "owner-changed", "client-changed"])("does not accept the concurrent binding winner after %s", async change => {
  mockUpdate.mockResolvedValue(null);
  mockFind.mockResolvedValue({ ...chat, app_binding: { app_id: "example-app", agent_id: "example-agent" },
    ...(change === "deleted" ? { deleted_at: new Date() } : change === "owner-changed" ? { owner_subject: "another-user" } : { client_type: "webex" }) });
  expect((await admitAppConversation(chat, target, stream))?.status).toBe(409);
});
