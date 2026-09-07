/**
 * @jest-environment node
 */

const mockGetCollection = jest.fn();
const mockFindUserIdByEmail = jest.fn();

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
  isMongoDBConfigured: true,
}));

jest.mock("@/lib/rbac/keycloak-admin", () => ({
  findUserIdByEmail: (...args: unknown[]) => mockFindUserIdByEmail(...args),
}));

import {
  isSchedulerTokenConfigured,
  isSchedulerTokenValid,
  resolveScheduledRunContext,
} from "../scheduled-run-auth";

const originalEnv = process.env;

describe("scheduled-run-auth", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      SCHEDULER_SERVICE_TOKEN: "scheduler-secret",
      CAIPE_SCHEDULER_SERVICE_TOKEN: "",
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("validates the scheduler token exactly", () => {
    expect(isSchedulerTokenConfigured()).toBe(true);
    expect(isSchedulerTokenValid("scheduler-secret")).toBe(true);
    expect(isSchedulerTokenValid("scheduler-secrex")).toBe(false);
    expect(isSchedulerTokenValid("short")).toBe(false);
    expect(isSchedulerTokenValid(null)).toBe(false);
  });

  it("resolves owner and agent only from the persisted schedule", async () => {
    const findOne = jest.fn().mockResolvedValue({
      schedule_id: "sched_123",
      owner_user_id: "owner@example.com",
      agent_id: "agent-persisted",
      project_id: "pod-safe",
      title: "Daily platform report",
    });
    mockGetCollection.mockResolvedValue({ findOne });
    mockFindUserIdByEmail.mockResolvedValue("owner-sub");

    await expect(resolveScheduledRunContext("sched_123")).resolves.toEqual({
      sub: "owner-sub",
      email: "owner@example.com",
      agentId: "agent-persisted",
      projectId: "pod-safe",
      scheduleTitle: "Daily platform report",
    });
    expect(findOne).toHaveBeenCalledWith({ schedule_id: "sched_123" });
    expect(mockFindUserIdByEmail).toHaveBeenCalledWith("owner@example.com");
  });

  it("uses the immutable persisted owner subject without an email lookup", async () => {
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({
        schedule_id: "sched_123",
        owner_sub: "owner-sub",
        owner_user_id: "owner@example.com",
        agent_id: "agent-persisted",
      }),
    });

    await expect(resolveScheduledRunContext("sched_123")).resolves.toEqual({
      sub: "owner-sub",
      email: "owner@example.com",
      agentId: "agent-persisted",
      projectId: null,
      scheduleTitle: null,
    });
    expect(mockFindUserIdByEmail).not.toHaveBeenCalled();
  });

  it("fails closed when the persisted schedule has no agent", async () => {
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({
        schedule_id: "sched_123",
        owner_user_id: "owner@example.com",
      }),
    });

    await expect(resolveScheduledRunContext("sched_123")).resolves.toBeNull();
    expect(mockFindUserIdByEmail).not.toHaveBeenCalled();
  });
});
