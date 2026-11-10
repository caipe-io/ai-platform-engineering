import { NOTIFICATION_EVENT_COPY } from "./copy";
import { createHash } from "node:crypto";
import { hasOrganizationAdmin } from "@/lib/rbac/platform-admin";

import { ApiError } from "@/lib/api-error";
import {
  canLaunchAgenticApp,
  agenticAppUserContextFromSession,
} from "@/lib/agentic-apps/access";
import {
  loadConfiguredAgenticApps,
  getConfiguredAgenticApp,
} from "@/lib/agentic-apps/config";
import {
  getRealmUserById,
  listRealmRoleMappingsForUser,
} from "@/lib/rbac/keycloak-admin";
import { getCollection } from "@/lib/mongodb";
import { NOTIFICATION_EVENT_TYPES } from "@/lib/notifications/taxonomy";
import {
  NOTIFICATION_CHANNELS,
  channelEnabled,
  type NotificationChannel,
  type NotificationSourceView,
  type NotificationSubscription,
  type NotificationTypeRegistration,
} from "./channels";
import type { User, UserSettings } from "@/types/mongodb";
import { isNotificationEnabled } from "./preferences";
import { isNotificationEventType } from "./taxonomy";

export interface SourceRegistration {
  _id: string;
  label: string;
  events: NotificationTypeRegistration[];
  updatedAt: Date;
}
interface SubscriptionDocument extends NotificationSubscription {
  _id: string;
  subject: string;
  sourceId: string;
  eventType: string;
  updatedAt: Date;
}

export function notificationKey(...parts: string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export async function registerAppNotificationTypes(
  appId: string,
  label: string,
  input: unknown,
): Promise<void> {
  if (!Array.isArray(input) || input.length < 1 || input.length > 30)
    throw new ApiError("Register 1 to 30 notification types", 400);
  const events = input.map((raw): NotificationTypeRegistration => {
    if (
      !raw ||
      typeof raw !== "object" ||
      !/^[a-z][a-z0-9_.-]{0,63}$/.test(raw.id) ||
      typeof raw.label !== "string" ||
      !raw.label.trim() ||
      raw.label.length > 100 ||
      (raw.description !== undefined &&
        (typeof raw.description !== "string" || raw.description.length > 300))
    ) {
      throw new ApiError(
        "Each notification type needs a valid id and label",
        400,
      );
    }
    return {
      id: raw.id,
      label: raw.label.trim(),
      ...(raw.description ? { description: raw.description } : {}),
    };
  });
  if (new Set(events.map((event) => event.id)).size !== events.length)
    throw new ApiError("Notification type ids must be unique", 400);
  const collection = await getCollection<SourceRegistration>(
    "notification_sources",
  );
  await collection.updateOne(
    { _id: `app:${appId}` },
    { $set: { label, events, updatedAt: new Date() } },
    { upsert: true },
  );
}

export async function getNotificationSource(
  sourceId: string,
): Promise<SourceRegistration | null> {
  if (sourceId === "platform")
    return {
      _id: "platform",
      label: "CAIPE",
      updatedAt: new Date(0),
      events: NOTIFICATION_EVENT_TYPES.map((id) => ({
        id,
        label: NOTIFICATION_EVENT_COPY[id].label,
        description: NOTIFICATION_EVENT_COPY[id].description,
      })),
    };
  const app = getConfiguredAgenticApp(
    sourceId.startsWith("app:") ? sourceId.slice(4) : "",
  );
  if (!app?.installation.installed || !app.installation.enabled) return null;
  return (
    await getCollection<SourceRegistration>("notification_sources")
  ).findOne({ _id: sourceId });
}

export async function readSubscription(
  subject: string,
  sourceId = "*",
  eventType = "*",
): Promise<NotificationSubscription | null> {
  return (
    await getCollection<SubscriptionDocument>("notification_subscriptions")
  ).findOne({ _id: notificationKey(subject, sourceId, eventType) });
}

export async function readSourceSubscriptions(
  subject: string,
  sourceId: string,
) {
  const rows = await (
    await getCollection<SubscriptionDocument>("notification_subscriptions")
  )
    .find({ subject, sourceId: { $in: ["*", sourceId] } })
    .limit(100)
    .toArray();
  return {
    global:
      rows.find((row) => row.sourceId === "*" && row.eventType === "*") ?? null,
    source:
      rows.find((row) => row.sourceId === sourceId && row.eventType === "*") ??
      null,
    events: new Map(
      rows
        .filter((row) => row.sourceId === sourceId && row.eventType !== "*")
        .map((row) => [row.eventType, row]),
    ),
  };
}

export async function writeSubscription(
  subject: string,
  sourceId: string,
  eventType: string,
  input: unknown,
): Promise<void> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new ApiError("Invalid subscription", 400);
  const raw = input as Record<string, unknown>;
  if (
    Object.keys(raw).some(
      (key) =>
        !["enabled", "pausedUntil", "channels", "quietHours"].includes(key),
    )
  )
    throw new ApiError("Unknown subscription setting", 400);
  const set: Record<string, unknown> = {
    subject,
    sourceId,
    eventType,
    updatedAt: new Date(),
  };
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== "boolean")
      throw new ApiError("enabled must be a boolean", 400);
    set.enabled = raw.enabled;
  }
  if (raw.pausedUntil !== undefined) {
    if (
      raw.pausedUntil !== null &&
      (typeof raw.pausedUntil !== "string" ||
        !Number.isFinite(Date.parse(raw.pausedUntil)))
    )
      throw new ApiError("pausedUntil must be a timestamp or null", 400);
    set.pausedUntil = raw.pausedUntil;
  }
  if (raw.channels !== undefined) {
    if (
      !raw.channels ||
      typeof raw.channels !== "object" ||
      Array.isArray(raw.channels)
    )
      throw new ApiError("Invalid channels", 400);
    for (const [channel, enabled] of Object.entries(raw.channels)) {
      if (
        !NOTIFICATION_CHANNELS.includes(channel as NotificationChannel) ||
        typeof enabled !== "boolean"
      )
        throw new ApiError("Unknown channel or invalid channel choice", 400);
      set[`channels.${channel}`] = enabled;
    }
  }
  if (raw.quietHours !== undefined) {
    const hours = raw.quietHours as NotificationSubscription["quietHours"];
    if (
      !hours ||
      typeof hours.enabled !== "boolean" ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(hours.start) ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(hours.end) ||
      typeof hours.timeZone !== "string" ||
      (hours.enabled && hours.start === hours.end)
    )
      throw new ApiError("Invalid quiet hours", 400);
    try {
      new Intl.DateTimeFormat("en", { timeZone: hours.timeZone });
    } catch {
      throw new ApiError("Unknown time zone", 400);
    }
    set.quietHours = {
      enabled: hours.enabled,
      start: hours.start,
      end: hours.end,
      timeZone: hours.timeZone,
    };
  }
  await (
    await getCollection<SubscriptionDocument>("notification_subscriptions")
  ).updateOne(
    { _id: notificationKey(subject, sourceId, eventType) },
    { $set: set },
    { upsert: true },
  );
}

export async function listNotificationSources(
  subject: string,
  session: Record<string, unknown>,
  role?: string,
  email?: string,
): Promise<NotificationSourceView[]> {
  const allowed = new Set(
    loadConfiguredAgenticApps()
      .filter((app) =>
        canLaunchAgenticApp(
          app,
          agenticAppUserContextFromSession(session, role),
        ),
      )
      .map((app) => `app:${app.manifest.id}`),
  );
  const registrations = await (
    await getCollection<SourceRegistration>("notification_sources")
  )
    .find({ _id: { $in: [...allowed] } })
    .limit(100)
    .toArray();
  const platform = await getNotificationSource("platform");
  const documents = await (
    await getCollection<SubscriptionDocument>("notification_subscriptions")
  )
    .find({ subject })
    .limit(4000)
    .toArray();
  const byKey = new Map(documents.map((row) => [row._id, row]));
  const settings = email
    ? await (
        await getCollection<UserSettings>("user_settings")
      ).findOne(
        { user_id: email },
        { projection: { notification_preferences: 1 } },
      )
    : null;
  return [platform!, ...registrations].map((source) => ({
    id: source._id,
    label: source.label,
    subscription: byKey.get(notificationKey(subject, source._id, "*")) ?? {
      enabled: source._id === "platform",
    },
    events: source.events.map((event) => ({
      ...event,
      subscription: {
        ...byKey.get(notificationKey(subject, source._id, event.id)),
        ...(source._id === "platform" && isNotificationEventType(event.id)
          ? {
              enabled: isNotificationEnabled(
                event.id,
                settings?.notification_preferences,
              ),
            }
          : {}),
      },
    })),
  }));
}

export async function deliveryAllowed(
  subject: string,
  sourceId: string,
  eventType: string,
  channel: NotificationChannel,
): Promise<boolean> {
  const { global, source, events } = await readSourceSubscriptions(
    subject,
    sourceId,
  );
  if (
    !channelEnabled(
      channel,
      global,
      source,
      events.get(eventType) ?? null,
      sourceId === "platform",
    )
  )
    return false;
  if (sourceId === "platform" && isNotificationEventType(eventType)) {
    const user = await (
      await getCollection<User>("users")
    ).findOne({
      $or: [{ keycloak_sub: subject }, { "metadata.keycloak_sub": subject }],
    } as never);
    if (!user) return false;
    const settings = await (
      await getCollection<UserSettings>("user_settings")
    ).findOne(
      { user_id: user.email },
      {
        projection: {
          notification_preferences: 1,
          "notifications.platform_health": 1,
        },
      },
    );
    if (
      eventType.startsWith("service.") &&
      (settings?.notifications?.platform_health === false ||
        !(await hasOrganizationAdmin({
          sub: subject,
          user: { email: user.email },
        })))
    )
      return false;
    if (!isNotificationEnabled(eventType, settings?.notification_preferences))
      return false;
  }
  if (sourceId !== "platform") {
    const app = getConfiguredAgenticApp(
      sourceId.startsWith("app:") ? sourceId.slice(4) : "",
    );
    const user = await (
      await getCollection<User>("users")
    ).findOne({
      $or: [{ keycloak_sub: subject }, { "metadata.keycloak_sub": subject }],
    } as never);
    if (!app || !user) return false;
    const [identity, roles] = await Promise.all([
      getRealmUserById(subject),
      listRealmRoleMappingsForUser(subject, true),
    ]);
    if (
      identity.enabled === false ||
      !canLaunchAgenticApp(app, { roles: roles.map((role) => role.name) })
    )
      return false;
    const registration = await getNotificationSource(sourceId);
    if (!registration?.events.some((event) => event.id === eventType))
      return false;
  }
  return true;
}
