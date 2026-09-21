export type InAppNotificationSeverity =
  | "info"
  | "success"
  | "warning"
  | "error";

export type InAppNotificationCategory = "general" | "platform_health";
export type InAppNotificationLifecycleStatus = "active" | "resolved";
export type InAppNotificationResolutionType = "automatic_audit" | "human";

export interface InAppNotificationDocument {
  _id: string;
  event_key: string;
  recipient_user_subjects: string[];
  recipient_team_slugs: string[];
  recipient_organization_admins: boolean;
  recipient_platform_users?: boolean;
  title: string;
  message: string;
  href?: string;
  severity: InAppNotificationSeverity;
  category?: InAppNotificationCategory;
  source_label?: string;
  correlation_key?: string;
  lifecycle_status?: InAppNotificationLifecycleStatus;
  resolved_at?: string;
  resolved_by_subject?: string;
  resolution_type?: InAppNotificationResolutionType;
  resolution_note?: string;
  created_at: string;
  updated_at: string;
  read_by_subjects: string[];
  archived_at?: string;
}

export interface InAppNotificationView {
  id: string;
  title: string;
  message: string;
  href?: string;
  severity: InAppNotificationSeverity;
  category: InAppNotificationCategory;
  source_label?: string;
  lifecycle_status?: InAppNotificationLifecycleStatus;
  resolved_at?: string;
  created_at: string;
  read: boolean;
}

export interface InAppNotificationPage {
  notifications: InAppNotificationView[];
  unread_count: number;
  pagination: {
    page: number;
    page_size: number;
    total: number;
    total_pages: number;
  };
}
