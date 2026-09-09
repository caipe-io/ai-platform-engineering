jest.mock("@/lib/mongodb", () => ({ getCollection: jest.fn() }));
jest.mock("@/lib/rbac/resource-authz", () => ({
  requireResourcePermission: jest.fn(),
}));

import { getCollection } from "@/lib/mongodb";
import { requireResourcePermission } from "@/lib/rbac/resource-authz";
import { validatePersistedAgentResourceDependencies } from "../agent-mcp-dependency-scope";

const mockGetCollection = getCollection as jest.Mock;
const mockRequireResourcePermission = requireResourcePermission as jest.Mock;

function collectionRows(rows: unknown[]) {
  return { find: jest.fn(() => ({ toArray: jest.fn(async () => rows) })) };
}

describe("agent skill and workflow dependency visibility", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireResourcePermission.mockResolvedValue(undefined);
  });

  it("rejects a global agent that embeds a private skill", async () => {
    mockGetCollection.mockImplementation(async (name: string) =>
      name === "agent_skills"
        ? collectionRows([
            {
              id: "skill-private",
              visibility: "private",
              owner_subject: "owner-a",
            },
          ])
        : collectionRows([]),
    );

    await expect(
      validatePersistedAgentResourceDependencies({
        session: { sub: "owner-a" },
        agent: { visibility: "global", ownerSubject: "owner-a" },
        skillIds: ["skill-private"],
      }),
    ).rejects.toMatchObject({ code: "PRIVATE_RESOURCE_DEPENDENCY_DENIED" });
  });

  it("allows a private agent to use private skills and workflows from the same owner", async () => {
    mockGetCollection.mockImplementation(async (name: string) =>
      name === "agent_skills"
        ? collectionRows([
            {
              id: "skill-private",
              visibility: "private",
              owner_subject: "owner-a",
            },
          ])
        : collectionRows([
            {
              _id: "wf-private",
              visibility: "private",
              owner_subject: "owner-a",
            },
          ]),
    );

    await expect(
      validatePersistedAgentResourceDependencies({
        session: { sub: "owner-a" },
        agent: { visibility: "private", ownerSubject: "owner-a" },
        skillIds: ["skill-private"],
        workflowIds: ["wf-private"],
      }),
    ).resolves.toBeUndefined();
  });

  it("matches legacy private dependencies by owner email", async () => {
    mockGetCollection.mockImplementation(async (name: string) =>
      name === "agent_skills"
        ? collectionRows([
            {
              id: "skill-legacy-private",
              visibility: "private",
              owner_id: "owner@example.com",
            },
          ])
        : collectionRows([]),
    );

    await expect(
      validatePersistedAgentResourceDependencies({
        session: { sub: "owner-a" },
        agent: {
          visibility: "private",
          ownerSubject: "owner-a",
          ownerEmail: "OWNER@example.com",
        },
        skillIds: ["skill-legacy-private"],
      }),
    ).resolves.toBeUndefined();
  });

  it("fails closed while a selected dependency is awaiting reconciliation", async () => {
    mockGetCollection.mockImplementation(async (name: string) =>
      name === "agent_skills"
        ? collectionRows([
            {
              id: "skill-pending",
              visibility: "global",
              authz_sync_state: "pending",
            },
          ])
        : collectionRows([]),
    );

    await expect(
      validatePersistedAgentResourceDependencies({
        session: { sub: "owner-a" },
        agent: { visibility: "global", ownerSubject: "owner-a" },
        skillIds: ["skill-pending"],
      }),
    ).rejects.toMatchObject({ code: "PRIVATE_RESOURCE_DEPENDENCY_DENIED" });
  });

  it("treats hub catalog skills as global instead of requiring agent_skills rows", async () => {
    mockGetCollection.mockImplementation(async () => collectionRows([]));

    await expect(
      validatePersistedAgentResourceDependencies({
        session: { sub: "owner-a" },
        agent: { visibility: "global", ownerSubject: "owner-a" },
        skillIds: ["hub-507f1f77bcf86cd799439011-safe-skill"],
      }),
    ).resolves.toBeUndefined();
  });
});
