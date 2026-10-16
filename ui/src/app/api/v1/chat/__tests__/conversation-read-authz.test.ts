/** @jest-environment node */

import { authorizeConversationReadAccess } from "../_conversation-authz";

const mockFindOne = jest.fn();
const mockRequirePermission = jest.fn();

jest.mock("@/lib/mongodb", () => ({
  getCollection: async () => ({ findOne: (...args: unknown[]) => mockFindOne(...args) }),
}));
jest.mock("@/lib/rbac/conversation-implicit-authz", () => ({
  requireConversationResourcePermission: (...args: unknown[]) => mockRequirePermission(...args),
}));

describe("durable conversation read authorization", () => {
  const caller = {
    subject: "example-subject",
    email: "reader@example.com",
    isServiceAccount: true,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockFindOne.mockResolvedValue({
      _id: "conversation-1",
      client_type: "slack",
      participants: [{ type: "agent", id: "agent-1" }],
    });
    mockRequirePermission.mockResolvedValue(undefined);
  });

  it("requires read permission even for Slack and preserves the service-account principal", async () => {
    const result = await authorizeConversationReadAccess(caller, "conversation-1", "agent-1");
    expect(result.denial).toBeNull();
    expect(mockRequirePermission).toHaveBeenCalledWith(
      { sub: "example-subject", user: { email: "reader@example.com" }, isServiceAccount: true },
      "reader@example.com",
      expect.objectContaining({ _id: "conversation-1" }),
      "read",
    );
  });

  it("denies unrelated agent bindings after authorizing the resource", async () => {
    const result = await authorizeConversationReadAccess(caller, "conversation-1", "agent-2");
    expect(result.denial?.status).toBe(403);
  });

  it("does not expose run state to a caller without conversation read permission", async () => {
    mockRequirePermission.mockRejectedValue(Object.assign(new Error("Access denied"), { statusCode: 403 }));
    const result = await authorizeConversationReadAccess(caller, "conversation-1", "agent-1");
    expect(result.denial?.status).toBe(403);
  });

  it("returns not found when the conversation does not exist", async () => {
    mockFindOne.mockResolvedValue(null);
    const result = await authorizeConversationReadAccess(caller, "conversation-1", "agent-1");
    expect(result.denial?.status).toBe(404);
    expect(mockRequirePermission).not.toHaveBeenCalled();
  });
});
