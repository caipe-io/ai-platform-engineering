/** @jest-environment node */

// Runs only against a real NATS server with JetStream enabled:
//   NATS_INTEGRATION_URL=nats://localhost:4222 npx jest notifications-jetstream
// Skipped otherwise, so the default test run never needs a broker.

import {
  publishNotificationEvent,
  startNotificationConsumer,
  stopNotificationConsumer,
} from "@/lib/notifications/consumer.server";
import { NOTIFICATION_STREAM } from "@/lib/notifications/transport.server";

const integrationUrl = process.env.NATS_INTEGRATION_URL;
const describeIfNats = integrationUrl ? describe : describe.skip;

const mockCreateInAppNotification = jest.fn();
const mockFindOne = jest.fn();

jest.mock("@/lib/in-app-notifications.server", () => ({
  createInAppNotification: (...args: unknown[]) => mockCreateInAppNotification(...args),
}));

jest.mock("@/lib/mongodb", () => ({
  getCollection: async () => ({ findOne: (...args: unknown[]) => mockFindOne(...args) }),
}));

function envelope(attempt: string) {
  return {
    id: "evt-integration",
    type: "workflow.completed",
    version: 1,
    occurred_at: "2026-10-14T10:00:00Z",
    resource: { type: "workflow_run", id: "run-integration" },
    attempt_id: attempt,
    recipient_subject: "subject-integration",
    recipient_email: "test-user@example.com",
    data: {
      status: "completed",
      title: "Workflow completed",
      summary: "Integration run finished.",
      href: "/workflows/run/run-integration",
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describeIfNats("JetStream notification transport", () => {
  const previousEnv = { ...process.env };

  beforeAll(async () => {
    process.env.NATS_URL = integrationUrl;
    process.env.NOTIFICATIONS_TRANSPORT = "jetstream";
    process.env.NOTIFICATION_EVENTS_ENABLED = "true";
    mockFindOne.mockResolvedValue(null);
    mockCreateInAppNotification.mockResolvedValue(undefined);
    startNotificationConsumer();
    // Give the consumer time to create the stream and durable consumer.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  });

  afterAll(async () => {
    await stopNotificationConsumer();
    process.env = previousEnv;
  });

  beforeEach(() => {
    mockCreateInAppNotification.mockClear();
    mockCreateInAppNotification.mockResolvedValue(undefined);
  });

  it("publishes, stores once, and ignores a duplicate publish", async () => {
    const attempt = `attempt-${Date.now()}`;

    const first = await publishNotificationEvent(envelope(attempt));
    expect(first).toBe("queued");
    await waitFor(() => mockCreateInAppNotification.mock.calls.length === 1);

    // Same id and attempt inside the duplicate window: NATS must reject it.
    await publishNotificationEvent(envelope(attempt));
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(mockCreateInAppNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateInAppNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKey: `workflow.completed:workflow_run:run-integration:${attempt}:subject-integration`,
        recipientUserSubjects: ["subject-integration"],
      }),
    );
  });

  it("redelivers when storage fails, then stores on the retry", async () => {
    const attempt = `attempt-retry-${Date.now()}`;
    mockCreateInAppNotification.mockRejectedValueOnce(new Error("mongo unavailable"));

    await publishNotificationEvent(envelope(attempt));
    // First delivery fails and is nak'd for 5 seconds, then redelivered.
    await waitFor(() => mockCreateInAppNotification.mock.calls.length >= 2, 20_000);
    expect(mockCreateInAppNotification).toHaveBeenCalledTimes(2);
  }, 30_000);

  it("terminates malformed messages instead of redelivering them", async () => {
    mockCreateInAppNotification.mockClear();
    const { connect } = await import("nats");
    const nc = await connect({ servers: integrationUrl });
    nc.jetstream().publish(`caipe.events.v1.workflow.completed`, "not-json");
    await nc.flush();
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(mockCreateInAppNotification).not.toHaveBeenCalled();
    await nc.close();
  });

  it("reports failed, not queued, when NATS is unreachable", async () => {
    await stopNotificationConsumer();
    process.env.NATS_URL = "nats://127.0.0.1:1";
    const outcome = await publishNotificationEvent(envelope(`attempt-down-${Date.now()}`));
    expect(outcome).toBe("failed");
    process.env.NATS_URL = integrationUrl;
  });

  it("uses the expected stream name", () => {
    expect(NOTIFICATION_STREAM).toBe("CAIPE_EVENTS");
  });
});
