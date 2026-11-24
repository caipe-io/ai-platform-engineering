import type { NotificationChannel } from "./channels";
import type { InAppNotificationSeverity } from "@/types/in-app-notification";

export interface NotificationDispatch {
  id: string;
  sourceId: string;
  sourceLabel: string;
  eventType: string;
  recipient: { subject: string; email: string };
  title: string;
  message: string;
  href?: string;
  severity: InAppNotificationSeverity;
  retentionDays?: number;
  correlationKey?: string;
  channels?: NotificationChannel[];
}

export interface NotificationDeliveryState {
  _id: string;
  status: "pending" | "processing" | "delivered" | "failed" | "skipped";
  attempts: number;
  availableAt: Date;
  leaseUntil?: Date;
  leaseToken?: string;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

export interface NotificationDelivery
  extends NotificationDispatch,
    NotificationDeliveryState {
  kind?: "notification";
  notificationId: string;
  channel: NotificationChannel;
  targetId?: string;
  browserDisplayedAt?: Date;
}

export class NotificationDeliveryError extends Error {
  constructor(
    message: string,
    readonly retryable = true,
    readonly retryAfterMs = 0,
  ) {
    super(message);
    this.name = "NotificationDeliveryError";
  }
}
