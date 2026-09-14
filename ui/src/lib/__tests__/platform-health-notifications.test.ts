/** @jest-environment node */

const mockCreateNotification = jest.fn();
const mockResolveNotification = jest.fn();
const state = new Map<string,Record<string,unknown>>();

const stateCollection = {
  findOne: jest.fn(async (filter: { _id: string }) => state.get(filter._id) ?? null),
  updateOne: jest.fn(async (filter: { _id: string },update: {
    $set?: Record<string,unknown>;
    $setOnInsert?: Record<string,unknown>;
    $unset?: Record<string,unknown>;
  }) => {
    const current = state.get(filter._id) ?? {};
    const next = { ...update.$setOnInsert,...current,...update.$set };
    for (const key of Object.keys(update.$unset ?? {})) delete next[key];
    state.set(filter._id,next);
    return { matchedCount: 1,modifiedCount: 1,upsertedCount: current ? 0 : 1 };
  }),
};

jest.mock("@/lib/mongodb",() => ({
  isMongoDBConfigured: true,
  getCollection: jest.fn(async (name: string) => {
    if (name === "platform_health_notification_states") return stateCollection;
    throw new Error(`Unexpected collection: ${name}`);
  }),
}));

jest.mock("@/lib/in-app-notifications.server",() => ({
  createInAppNotification: (...args: unknown[]) => mockCreateNotification(...args),
  resolveInAppNotification: (...args: unknown[]) => mockResolveNotification(...args),
}));

import {
  reconcilePlatformHealthNotifications,
  resolvePlatformHealthNotification,
} from "@/lib/platform-health-notifications.server";

const degraded = {
  id: "chat-runtime",
  label: "Chat Runtime",
  status: "degraded" as const,
  required: true,
  detail: "Runtime health check failed.",
};

beforeEach(() => {
  state.clear();
  jest.clearAllMocks();
  process.env.PLATFORM_HEALTH_NOTIFICATION_FAILURE_THRESHOLD = "2";
  process.env.PLATFORM_HEALTH_NOTIFICATION_RECOVERY_THRESHOLD = "2";
});

it("opens one global Platform incident only after consecutive failures",async () => {
  await reconcilePlatformHealthNotifications({ checkedAt: "2026-08-20T10:00:00.000Z",capabilities: [degraded] });
  expect(mockCreateNotification).not.toHaveBeenCalled();

  await reconcilePlatformHealthNotifications({ checkedAt: "2026-08-20T10:00:30.000Z",capabilities: [degraded] });

  expect(mockCreateNotification).toHaveBeenCalledTimes(1);
  expect(mockCreateNotification).toHaveBeenCalledWith(expect.objectContaining({
    recipientOrganizationAdmins: true,
    sourceLabel: "Platform",
    category: "platform_health",
    lifecycleStatus: "active",
    severity: "warning",
  }));
});

it("automatically resolves an incident after consecutive healthy audits",async () => {
  await reconcilePlatformHealthNotifications({ checkedAt: "2026-08-20T10:00:00.000Z",capabilities: [degraded] });
  await reconcilePlatformHealthNotifications({ checkedAt: "2026-08-20T10:00:30.000Z",capabilities: [degraded] });
  const healthy = { ...degraded,status: "healthy" as const,detail: "Ready" };
  await reconcilePlatformHealthNotifications({ checkedAt: "2026-08-20T10:01:00.000Z",capabilities: [healthy] });
  await reconcilePlatformHealthNotifications({ checkedAt: "2026-08-20T10:01:30.000Z",capabilities: [healthy] });

  expect(mockResolveNotification).toHaveBeenCalledWith(expect.objectContaining({
    resolutionType: "automatic_audit",
  }));
  expect(mockCreateNotification).toHaveBeenLastCalledWith(expect.objectContaining({
    recipientOrganizationAdmins: true,
    lifecycleStatus: "resolved",
    severity: "success",
    title: "Chat Runtime recovered",
  }));
});

it("supports a global human resolution without altering viewer read state",async () => {
  await reconcilePlatformHealthNotifications({ checkedAt: "2026-08-20T10:00:00.000Z",capabilities: [degraded] });
  await reconcilePlatformHealthNotifications({ checkedAt: "2026-08-20T10:00:30.000Z",capabilities: [degraded] });

  await expect(resolvePlatformHealthNotification({
    componentId: "chat-runtime",
    actorSubject: "admin-subject",
    note: "Reviewed during incident response.",
  })).resolves.toBe(true);

  expect(mockResolveNotification).toHaveBeenCalledWith(expect.objectContaining({
    resolvedBySubject: "admin-subject",
    resolutionType: "human",
    resolutionNote: "Reviewed during incident response.",
  }));
});
