import type { NotificationChannel } from "./channels";

export type EventAudience = "recipients" | "organization_admins" | "approval_reviewers";
export interface NotificationEventPolicy {
  sourceId: string;
  eventType: string;
  label: string;
  description: string;
  enabled: boolean;
  defaultEnabled: boolean;
  audience: EventAudience;
  allowedChannels: NotificationChannel[];
  revision: number;
  locked: boolean;
  retired?: boolean;
  /** Advances on retirement/restoration so older queued deliveries cannot replay. */
  deliveryGeneration?: number;
}
