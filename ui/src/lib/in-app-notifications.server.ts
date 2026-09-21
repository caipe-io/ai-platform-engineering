import { randomUUID } from "node:crypto";

import { getCollection } from "@/lib/mongodb";
import { checkOpenFgaTuple, listOpenFgaObjects } from "@/lib/rbac/openfga";
import { organizationObjectId } from "@/lib/rbac/organization";
import type {
  InAppNotificationDocument,
  InAppNotificationPage,
  InAppNotificationCategory,
  InAppNotificationLifecycleStatus,
  InAppNotificationResolutionType,
  InAppNotificationSeverity,
} from "@/types/in-app-notification";

const NOTIFICATION_COLLECTION = "in_app_notifications";

function normalizedStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort();
}

function teamSlugFromObject(value: string): string | null {
  const match = /^team:(.+)$/.exec(value);
  return match?.[1]?.trim() || null;
}

async function notificationAudienceQuery(
  subject: string,
  options: { includePlatformNotifications?: boolean } = {},
): Promise<Record<string, unknown>> {
  let teamSlugs: string[] = [];
  let organizationAdmin = false;
  const [teamResult, adminResult] = await Promise.allSettled([
    listOpenFgaObjects({
      user: `user:${subject}`,
      relation: "member",
      type: "team",
    }),
    checkOpenFgaTuple({
      user: `user:${subject}`,
      relation: "can_manage",
      object: organizationObjectId(),
    }),
  ]);
  if (teamResult.status === "fulfilled") {
    const result = teamResult.value;
    teamSlugs = result.objects
      .map(teamSlugFromObject)
      .filter((value): value is string => Boolean(value));
  } else {
    console.error(
      "[notifications] could not resolve team memberships",
      teamResult.reason,
    );
  }
  if (adminResult.status === "fulfilled") {
    organizationAdmin = adminResult.value.allowed;
  } else {
    console.error(
      "[notifications] could not resolve organization access",
      adminResult.reason,
    );
  }
  return {
    archived_at: { $exists: false },
    ...(options.includePlatformNotifications === false
      ? { category: { $ne: "platform_health" } }
      : {}),
    $or: [
      { recipient_user_subjects: subject },
      ...(teamSlugs.length > 0
        ? [{ recipient_team_slugs: { $in: teamSlugs } }]
        : []),
      ...(organizationAdmin ? [{ recipient_organization_admins: true }] : []),
      { recipient_platform_users: true },
    ],
  };
}

export async function createInAppNotification(input: {
  eventKey: string;
  recipientUserSubjects?: string[];
  recipientTeamSlugs?: string[];
  recipientOrganizationAdmins?: boolean;
  recipientPlatformUsers?: boolean;
  title: string;
  message: string;
  href?: string;
  severity?: InAppNotificationSeverity;
  category?: InAppNotificationCategory;
  sourceLabel?: string;
  correlationKey?: string;
  lifecycleStatus?: InAppNotificationLifecycleStatus;
}): Promise<void> {
  const recipientUserSubjects = normalizedStrings(input.recipientUserSubjects ?? []);
  const recipientTeamSlugs = normalizedStrings(input.recipientTeamSlugs ?? []);
  const recipientOrganizationAdmins = input.recipientOrganizationAdmins === true;
  const recipientPlatformUsers = input.recipientPlatformUsers === true;
  if (
    recipientUserSubjects.length === 0 &&
    recipientTeamSlugs.length === 0 &&
    !recipientOrganizationAdmins &&
    !recipientPlatformUsers
  ) return;

  const collection = await getCollection<InAppNotificationDocument>(
    NOTIFICATION_COLLECTION,
  );
  const now = new Date().toISOString();
  await collection.updateOne(
    { event_key: input.eventKey } as never,
    {
      $setOnInsert: {
        _id: randomUUID(),
        event_key: input.eventKey,
        recipient_user_subjects: recipientUserSubjects,
        recipient_team_slugs: recipientTeamSlugs,
        recipient_organization_admins: recipientOrganizationAdmins,
        recipient_platform_users: recipientPlatformUsers,
        title: input.title,
        message: input.message,
        ...(input.href ? { href: input.href } : {}),
        severity: input.severity ?? "info",
        category: input.category ?? "general",
        ...(input.sourceLabel ? { source_label: input.sourceLabel } : {}),
        ...(input.correlationKey ? { correlation_key: input.correlationKey } : {}),
        ...(input.lifecycleStatus ? { lifecycle_status: input.lifecycleStatus } : {}),
        created_at: now,
        updated_at: now,
        read_by_subjects: [],
      },
    } as never,
    { upsert: true },
  );
}

export async function resolveInAppNotification(input: {
  eventKey: string;
  resolvedAt: string;
  resolvedBySubject?: string;
  resolutionType: InAppNotificationResolutionType;
  resolutionNote?: string;
}): Promise<boolean> {
  const collection = await getCollection<InAppNotificationDocument>(
    NOTIFICATION_COLLECTION,
  );
  const result = await collection.updateOne(
    { event_key: input.eventKey, archived_at: { $exists: false } } as never,
    {
      $set: {
        lifecycle_status: "resolved",
        resolved_at: input.resolvedAt,
        resolution_type: input.resolutionType,
        ...(input.resolvedBySubject
          ? { resolved_by_subject: input.resolvedBySubject }
          : {}),
        ...(input.resolutionNote ? { resolution_note: input.resolutionNote } : {}),
        updated_at: input.resolvedAt,
      },
    } as never,
  );
  return result.matchedCount > 0;
}

export async function archiveInAppNotifications(
  eventKeys: string[],
): Promise<void> {
  const keys = normalizedStrings(eventKeys);
  if (keys.length === 0) return;
  const collection = await getCollection<InAppNotificationDocument>(
    NOTIFICATION_COLLECTION,
  );
  const now = new Date().toISOString();
  await collection.updateMany(
    { event_key: { $in: keys }, archived_at: { $exists: false } } as never,
    { $set: { archived_at: now, updated_at: now } } as never,
  );
}

export async function listInAppNotifications(
  subject: string,
  options: {
    page?: number;
    pageSize?: number;
    includePlatformNotifications?: boolean;
  } = {},
): Promise<InAppNotificationPage> {
  const collection = await getCollection<InAppNotificationDocument>(
    NOTIFICATION_COLLECTION,
  );
  const audience = await notificationAudienceQuery(subject, options);
  const requestedPage = Math.max(1, Math.floor(options.page ?? 1));
  const pageSize = Math.min(50, Math.max(1, Math.floor(options.pageSize ?? 10)));
  const [total, unreadCount] = await Promise.all([
    collection.countDocuments(audience as never),
    collection.countDocuments({
      $and: [audience, { read_by_subjects: { $ne: subject } }],
    } as never),
  ]);
  const totalPages = total === 0 ? 1 : Math.ceil(total / pageSize);
  const page = Math.min(requestedPage, totalPages);
  const rows = await collection
    .find(audience as never)
    .sort({ created_at: -1, _id: -1 })
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .toArray();

  return {
    notifications: rows.map((row) => ({
      id: row._id,
      title: row.title,
      message: row.message,
      ...(row.href ? { href: row.href } : {}),
      severity: row.severity,
      category: row.category ?? "general",
      ...(row.source_label ? { source_label: row.source_label } : {}),
      ...(row.lifecycle_status
        ? { lifecycle_status: row.lifecycle_status }
        : {}),
      ...(row.resolved_at ? { resolved_at: row.resolved_at } : {}),
      created_at: row.created_at,
      read: row.read_by_subjects.includes(subject),
    })),
    unread_count: unreadCount,
    pagination: {
      page,
      page_size: pageSize,
      total,
      total_pages: totalPages,
    },
  };
}

export async function markInAppNotificationRead(
  subject: string,
  id: string,
  options: { includePlatformNotifications?: boolean } = {},
): Promise<boolean> {
  const collection = await getCollection<InAppNotificationDocument>(
    NOTIFICATION_COLLECTION,
  );
  const audience = await notificationAudienceQuery(subject, options);
  const result = await collection.updateOne(
    { $and: [{ _id: id }, audience] } as never,
    {
      $addToSet: { read_by_subjects: subject },
      $set: { updated_at: new Date().toISOString() },
    } as never,
  );
  return result.matchedCount > 0;
}

export async function markAllInAppNotificationsRead(
  subject: string,
  options: { includePlatformNotifications?: boolean } = {},
): Promise<number> {
  const collection = await getCollection<InAppNotificationDocument>(
    NOTIFICATION_COLLECTION,
  );
  const audience = await notificationAudienceQuery(subject, options);
  const result = await collection.updateMany(
    { $and: [audience, { read_by_subjects: { $ne: subject } }] } as never,
    {
      $addToSet: { read_by_subjects: subject },
      $set: { updated_at: new Date().toISOString() },
    } as never,
  );
  return result.modifiedCount;
}
