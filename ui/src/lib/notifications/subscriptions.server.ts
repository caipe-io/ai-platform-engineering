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
      typeof raw.id !== "string" ||
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
  eventTypes: readonly string[],
) {
  const globalKey = notificationKey(subject, "*", "*");
  const sourceKey = notificationKey(subject, sourceId, "*");
  const eventKeys = eventTypes.map((eventType) =>
    notificationKey(subject, sourceId, eventType),
  );
  const rows = await (
    await getCollection<SubscriptionDocument>("notification_subscriptions")
  )
    .find({ _id: { $in: [globalKey, sourceKey, ...eventKeys] } })
    .toArray();
  const byKey = new Map(rows.map((row) => [row._id, row]));
  const events = new Map<string, NotificationSubscription>();
  eventTypes.forEach((eventType, index) => {
    const row = byKey.get(eventKeys[index]);
    if (row) events.set(eventType, row);
  });
  return {
    global: byKey.get(globalKey) ?? null,
    source: byKey.get(sourceKey) ?? null,
    events,
  };
}

export function parseSubscriptionPatch(input: unknown): NotificationSubscription {
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
  const patch: NotificationSubscription = {};
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== "boolean")
      throw new ApiError("enabled must be a boolean", 400);
    patch.enabled = raw.enabled;
  }
  if (raw.pausedUntil !== undefined) {
    if (
      raw.pausedUntil !== null &&
      (typeof raw.pausedUntil !== "string" ||
        !Number.isFinite(Date.parse(raw.pausedUntil)))
    )
      throw new ApiError("pausedUntil must be a timestamp or null", 400);
    patch.pausedUntil = typeof raw.pausedUntil === "string" ? raw.pausedUntil : null;
  }
  if (raw.channels !== undefined) {
    if (
      !raw.channels ||
      typeof raw.channels !== "object" ||
      Array.isArray(raw.channels)
    )
      throw new ApiError("Invalid channels", 400);
    const channels: NonNullable<NotificationSubscription["channels"]> = {};
    for (const [channel, enabled] of Object.entries(raw.channels)) {
      if (
        !NOTIFICATION_CHANNELS.includes(channel as NotificationChannel) ||
        typeof enabled !== "boolean"
      )
        throw new ApiError("Unknown channel or invalid channel choice", 400);
      channels[channel as NotificationChannel] = enabled;
    }
    patch.channels = channels;
  }
  if (raw.quietHours !== undefined) {
    const hours = raw.quietHours as NotificationSubscription["quietHours"];
    if (
      !hours ||
      typeof hours.enabled !== "boolean" ||
      typeof hours.start !== "string" ||
      typeof hours.end !== "string" ||
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
    patch.quietHours = {
      enabled: hours.enabled,
      start: hours.start,
      end: hours.end,
      timeZone: hours.timeZone,
    };
  }
  return patch;
}

export async function writeSubscription(
  subject: string,
  sourceId: string,
  eventType: string,
  patch: NotificationSubscription,
): Promise<void> {
  const { channels, ...fields } = patch;
  const set = {
    ...fields,
    ...Object.fromEntries(
      Object.entries(channels ?? {}).map(([channel, enabled]) => [`channels.${channel}`, enabled]),
    ),
    subject,
    sourceId,
    eventType,
    updatedAt: new Date(),
  };
  await (
    await getCollection<SubscriptionDocument>("notification_subscriptions")
  ).updateOne(
    { _id: notificationKey(subject, sourceId, eventType) },
    { $set: set },
    { upsert: true },
  );
}

export async function allowedNotificationAppSourceIds(
  subject: string,
  session: Record<string, unknown>,
  role?: string,
): Promise<string[]> {
  const context = agenticAppUserContextFromSession(session, role);
  if (session.authMethod === "bearer" && session.principalType === "oidc_user") {
    // Bearer sessions do not carry realm roles. App-specific roles are read
    // from Keycloak; the platform administrator role still requires a session.
    const mappings = await listRealmRoleMappingsForUser(subject, true);
    context.roles = mappings.map((mapping) => mapping.name).filter((name) => name !== "admin");
  }
  return loadConfiguredAgenticApps()
    .filter((app) => canLaunchAgenticApp(app, context))
    .map((app) => `app:${app.manifest.id}`);
}

export async function listNotificationSources(
  subject: string,
  session: Record<string, unknown>,
  role?: string,
  email?: string,
): Promise<NotificationSourceView[]> {
  const allowed = await allowedNotificationAppSourceIds(subject, session, role);
  const registrations = await (
    await getCollection<SourceRegistration>("notification_sources")
  )
    .find({ _id: { $in: allowed } })
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
    [eventType],
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
      // Sign-in assigns every authenticated person the baseline user role;
      // it need not exist as an explicit realm-role mapping. Never infer an
      // admin/custom role from the cached user document at delivery time.
      !canLaunchAgenticApp(app, { role: "user", roles: roles.map((role) => role.name) })
    )
      return false;
    const registration = await getNotificationSource(sourceId);
    if (!registration?.events.some((event) => event.id === eventType))
      return false;
  }
  return true;
}
