/** @jest-environment node */
import { publishNotificationEvent } from "@/lib/notifications/consumer.server";
const mockEnqueue = jest.fn();
jest.mock("@/lib/notifications/delivery.server", () => ({ enqueueNotification: (...args: unknown[]) => mockEnqueue(...args) }));
const originalEnv = { ...process.env };
afterEach(() => { process.env = { ...originalEnv }; jest.restoreAllMocks(); });
it("does not fall back to direct delivery when configured JetStream cannot publish", async () => {
  process.env.NOTIFICATION_EVENTS_ENABLED = "true";
  process.env.NOTIFICATIONS_TRANSPORT = "jetstream";
  process.env.NATS_URL = "nats://127.0.0.1:1";
  jest.spyOn(console, "error").mockImplementation(() => {});
  const outcome = await publishNotificationEvent({
    id: "example-event", type: "workflow.completed", version: 1,
    occurred_at: "2026-10-01T10:00:00Z", resource: { type: "workflow_run", id: "example-run" },
    attempt_id: "example-attempt", recipient_subject: "example-user", recipient_email: "example@example.test",
    data: { status: "completed", title: "Example finished", summary: "Example run finished." },
  });
  expect(outcome).toBe("failed");
  expect(mockEnqueue).not.toHaveBeenCalled();
});
