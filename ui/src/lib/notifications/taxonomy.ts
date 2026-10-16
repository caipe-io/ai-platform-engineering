import type { InAppNotificationSeverity } from "@/types/in-app-notification";

// Central catalog of notification-worthy events. Producers may only publish
// types listed here, and only for lifecycle points that actually fire.
export const NOTIFICATION_CATEGORIES = [
  "ingestion",
  "workflow",
  "agent",
  "platform",
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const NOTIFICATION_EVENT_TYPES = [
  "ingestion.completed",
  "ingestion.failed",
  "ingestion.started",
  "workflow.completed",
  "workflow.failed",
  "workflow.requires_input",
  "workflow.started",
  "agent.completed",
  "agent.failed",
  "agent.started",
  "service.degraded",
  "service.recovered",
] as const;

export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

export interface NotificationEventDefinition {
  type: NotificationEventType;
  category: NotificationCategory;
  /** Whether a user who has set no preference receives this event. */
  defaultEnabled: boolean;
  severity: InAppNotificationSeverity;
}

export const NOTIFICATION_EVENT_CATALOG: Record<
  NotificationEventType,
  NotificationEventDefinition
> = {
  "ingestion.completed": { type: "ingestion.completed", category: "ingestion", defaultEnabled: true, severity: "success" },
  "ingestion.failed": { type: "ingestion.failed", category: "ingestion", defaultEnabled: true, severity: "error" },
  "ingestion.started": { type: "ingestion.started", category: "ingestion", defaultEnabled: false, severity: "info" },
  "workflow.completed": { type: "workflow.completed", category: "workflow", defaultEnabled: true, severity: "success" },
  "workflow.failed": { type: "workflow.failed", category: "workflow", defaultEnabled: true, severity: "error" },
  "workflow.requires_input": { type: "workflow.requires_input", category: "workflow", defaultEnabled: true, severity: "warning" },
  "workflow.started": { type: "workflow.started", category: "workflow", defaultEnabled: false, severity: "info" },
  "agent.completed": { type: "agent.completed", category: "agent", defaultEnabled: true, severity: "success" },
  "agent.failed": { type: "agent.failed", category: "agent", defaultEnabled: true, severity: "error" },
  "agent.started": { type: "agent.started", category: "agent", defaultEnabled: false, severity: "info" },
  "service.degraded": { type: "service.degraded", category: "platform", defaultEnabled: true, severity: "warning" },
  "service.recovered": { type: "service.recovered", category: "platform", defaultEnabled: true, severity: "success" },
};

export function isNotificationEventType(value: unknown): value is NotificationEventType {
  return (
    typeof value === "string" &&
    (NOTIFICATION_EVENT_TYPES as readonly string[]).includes(value)
  );
}

export function isNotificationCategory(value: unknown): value is NotificationCategory {
  return (
    typeof value === "string" &&
    (NOTIFICATION_CATEGORIES as readonly string[]).includes(value)
  );
}
