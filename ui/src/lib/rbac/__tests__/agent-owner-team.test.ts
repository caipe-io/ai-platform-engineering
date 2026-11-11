/** @jest-environment node */

import { canUseAgentOwnerTeam } from "../agent-owner-team";

const mockRequireResourcePermission = jest.fn();
jest.mock("../resource-authz", () => ({
  requireResourcePermission: (...args: unknown[]) => mockRequireResourcePermission(...args),
}));

describe("agent owner-team authorization", () => {
  const session = { sub: "test-user" };
  beforeEach(() => jest.clearAllMocks());

  it("accepts a verified team-use grant", async () => {
    mockRequireResourcePermission.mockResolvedValue(undefined);
    expect(await canUseAgentOwnerTeam(session, "primary")).toBe(true);
    expect(mockRequireResourcePermission).toHaveBeenCalledTimes(1);
    expect(mockRequireResourcePermission).toHaveBeenCalledWith(session, {
      type: "team", id: "primary", action: "use",
    });
  });

  it("accepts a team manager whose projection has no use grant", async () => {
    mockRequireResourcePermission.mockRejectedValueOnce(new Error("denied"))
      .mockResolvedValueOnce(undefined);
    expect(await canUseAgentOwnerTeam(session, "primary")).toBe(true);
    expect(mockRequireResourcePermission).toHaveBeenLastCalledWith(session, {
      type: "team", id: "primary", action: "manage",
    });
  });

  it("denies when neither team grant can be verified", async () => {
    mockRequireResourcePermission.mockRejectedValue(new Error("denied"));
    expect(await canUseAgentOwnerTeam(session, "secondary")).toBe(false);
    expect(mockRequireResourcePermission).toHaveBeenCalledTimes(2);
  });

  it("rejects a missing team slug without an authorization request", async () => {
    expect(await canUseAgentOwnerTeam(session, " ")).toBe(false);
    expect(mockRequireResourcePermission).not.toHaveBeenCalled();
  });
});
