import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_EVENT_CATALOG,
  NOTIFICATION_EVENT_TYPES,
  type NotificationCategory,
  type NotificationEventType,
} from "@/lib/notifications/taxonomy";

/** Sparse explicit choices. A missing key means "fall back to the next level". */
export interface NotificationPreferences {
  categories?: Partial<Record<NotificationCategory, boolean>>;
  events?: Partial<Record<NotificationEventType, boolean>>;
}

/**
 * Effective setting for one event type: explicit event, then explicit
 * category, then the catalog default. Repeated writes of the same preferences
 * always resolve the same way.
 */
export function isNotificationEnabled(
  type: NotificationEventType,
  preferences: NotificationPreferences | null | undefined,
): boolean {
  const explicitEvent = preferences?.events?.[type];
  if (typeof explicitEvent === "boolean") return explicitEvent;

  const category = NOTIFICATION_EVENT_CATALOG[type].category;
  const explicitCategory = preferences?.categories?.[category];
  if (typeof explicitCategory === "boolean") return explicitCategory;

  return NOTIFICATION_EVENT_CATALOG[type].defaultEnabled;
}

/** A patch value of `null` removes the explicit override and returns to the default. */
export interface NotificationPreferencePatch {
  categories?: Partial<Record<NotificationCategory, boolean | null>>;
  events?: Partial<Record<NotificationEventType, boolean | null>>;
}

/**
 * Applies a validated patch to stored preferences. `true` and `false` set an
 * override. `null` removes it. Returns a new object, so the caller's copy is
 * never mutated.
 */
export function mergeNotificationPreferences(
  current: NotificationPreferences | null,
  patch: NotificationPreferencePatch,
): NotificationPreferences {
  return {
    categories: applyPatchSection(current?.categories, patch.categories),
    events: applyPatchSection(current?.events, patch.events),
  };
}

function applyPatchSection<K extends string>(
  current: Partial<Record<K, boolean>> | undefined,
  patch: Partial<Record<K, boolean | null>> | undefined,
): Partial<Record<K, boolean>> {
  const next: Partial<Record<K, boolean>> = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(patch ?? {}) as [K, boolean | null][]) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

export type PreferencePatchResult =
  | { ok: true; patch: NotificationPreferencePatch }
  | { ok: false; error: string };

/**
 * Validates a client-supplied preference update. Only known categories and
 * event types are accepted, and every value must be a boolean. Anything else is
 * rejected so the stored document can only hold catalog keys.
 */
export function parseNotificationPreferencePatch(input: unknown): PreferencePatchResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "preferences must be an object" };
  }
  const raw = input as Record<string, unknown>;
  const allowedTop = new Set(["categories", "events"]);
  for (const key of Object.keys(raw)) {
    if (!allowedTop.has(key)) return { ok: false, error: `unknown preference section: ${key}` };
  }

  const patch: NotificationPreferencePatch = {};

  if (raw.categories !== undefined) {
    const section = parseBooleanMap(raw.categories, NOTIFICATION_CATEGORIES);
    if (section.ok === false) return { ok: false, error: `categories: ${section.error}` };
    patch.categories = section.value as Partial<Record<NotificationCategory, boolean | null>>;
  }

  if (raw.events !== undefined) {
    const section = parseBooleanMap(raw.events, NOTIFICATION_EVENT_TYPES);
    if (section.ok === false) return { ok: false, error: `events: ${section.error}` };
    patch.events = section.value as Partial<Record<NotificationEventType, boolean | null>>;
  }

  return { ok: true, patch };
}

function parseBooleanMap(
  input: unknown,
  allowed: readonly string[],
): { ok: true; value: Record<string, boolean | null> } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "must be an object" };
  }
  const value: Record<string, boolean | null> = {};
  for (const [key, flag] of Object.entries(input as Record<string, unknown>)) {
    if (!allowed.includes(key)) return { ok: false, error: `unknown key: ${key}` };
    if (flag !== null && typeof flag !== "boolean") {
      return { ok: false, error: `${key} must be a boolean or null` };
    }
    value[key] = flag as boolean | null;
  }
  return { ok: true, value };
}
