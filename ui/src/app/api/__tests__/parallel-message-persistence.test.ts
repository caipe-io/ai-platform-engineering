/** @jest-environment node */
import { NextRequest } from "next/server";
import { POST, GET } from "@/app/api/chat/conversations/[id]/messages/route";

const mockRows: Record<string, unknown>[] = [];
const mockCollection = {
  updateOne: jest.fn(async (_filter, update) => {
    mockRows.push({ ...update.$setOnInsert, ...update.$set });
    return { upsertedId: "example-message" };
  }),
  findOne: jest.fn(async ({ message_id }) => mockRows.find(row => row.message_id === message_id)),
  countDocuments: jest.fn(async () => mockRows.length),
  find: () => ({ sort: () => ({ skip: () => ({ limit: () => ({ toArray: async () => mockRows }) }) }) }),
};
const mockConversation = { _id: "12345678-1234-4123-8123-123456789abc", owner_id: "owner@example.test", participants: [{ type: "agent", id: "primary" }] };
jest.mock("@/lib/mongodb", () => ({ getCollection: async (name: string) => name === "messages" ? mockCollection : name === "dynamic_agents" ? { findOne: async () => ({ name: "Example agent" }) } : { updateOne: jest.fn() } }));
jest.mock("@/lib/rbac/conversation-implicit-authz", () => ({ requireConversationResourcePermission: jest.fn() }));
jest.mock("@/lib/api-middleware", () => ({ ...jest.requireActual("@/lib/api-middleware"),
  getAuthFromBearerOrSession: async () => ({ user: { email: "owner@example.test" }, session: { sub: "example-owner" } }),
  requireConversationAccess: async () => ({ conversation: mockConversation }),
}));

it("round-trips parallel grouping for both prompts and replies through the API", async () => {
  const params = { params: Promise.resolve({ id: mockConversation._id }) };
  for (const role of ["user", "assistant"]) {
    const response = await POST(new NextRequest("https://example.test/api/messages", {
      method: "POST", body: JSON.stringify({ message_id: `example-${role}`, role, content: "Example", metadata: { turn_id: "example-turn", agent_id: "primary", parallel_group_id: "example-group", is_final: true } }),
    }), params);
    expect(response.status).toBe(201);
    expect((await response.json()).data.metadata.parallel_group_id).toBe("example-group");
  }
  const response = await GET(new NextRequest("https://example.test/api/messages"), params);
  const body = await response.json();
  expect(body.data.items).toHaveLength(2);
  expect(body.data.items.every((row: { metadata: { parallel_group_id: string } }) => row.metadata.parallel_group_id === "example-group")).toBe(true);
});
