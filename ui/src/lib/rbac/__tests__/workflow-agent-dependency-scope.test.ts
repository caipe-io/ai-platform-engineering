jest.mock("@/lib/mongodb", () => ({ getCollection: jest.fn() }));
jest.mock("@/lib/rbac/resource-authz", () => ({
  requireAgentPermission: jest.fn(),
}));

import { getCollection } from "@/lib/mongodb";
import { validateWorkflowAgentDependencies } from "../workflow-agent-dependency-scope";

const mockGetCollection = getCollection as jest.Mock;

function setAgents(agents: unknown[]): void {
  mockGetCollection.mockResolvedValue({
    find: jest.fn(() => ({ toArray: jest.fn(async () => agents) })),
  });
}

const steps = [
  {
    type: "step" as const,
    display_text: "Run",
    agent_id: "agent-private",
    prompt: "Run it",
    on_error: "abort" as const,
  },
];

describe("workflow agent dependency visibility", () => {
  beforeEach(() => jest.clearAllMocks());

  it("rejects a private agent inside a team or global workflow", async () => {
    setAgents([
      {
        _id: "agent-private",
        visibility: "private",
        owner_subject: "owner-a",
        owner_id: "owner@example.com",
      },
    ]);

    await expect(
      validateWorkflowAgentDependencies({
        session: { sub: "owner-a" },
        workflow: {
          visibility: "team",
          ownerSubject: "owner-a",
          ownerEmail: "owner@example.com",
        },
        steps,
      }),
    ).rejects.toMatchObject({ code: "PRIVATE_RESOURCE_DEPENDENCY_DENIED" });
  });

  it("allows same-owner private composition", async () => {
    setAgents([
      {
        _id: "agent-private",
        visibility: "private",
        owner_subject: "owner-a",
        owner_id: "owner@example.com",
      },
    ]);

    await expect(
      validateWorkflowAgentDependencies({
        session: { sub: "owner-a" },
        workflow: {
          visibility: "private",
          ownerSubject: "owner-a",
          ownerEmail: "owner@example.com",
        },
        steps,
      }),
    ).resolves.toBeUndefined();
  });
});
