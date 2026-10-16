import {
  isNotificationEventType,
  type NotificationEventType,
} from "@/lib/notifications/taxonomy";

export const NOTIFICATION_ENVELOPE_VERSION = 1;

const MAX_ID_LENGTH = 200;
const MAX_SUMMARY_LENGTH = 500;
const MAX_TITLE_LENGTH = 200;

/**
 * Event published by a producer. Producers are trusted server-side code, so
 * the envelope never carries client-supplied audiences. `recipient_subject`
 * is set by the producer from authenticated context, and the consumer still
 * checks it against preferences before writing anything.
 */
export interface NotificationEnvelope {
  id: string;
  type: NotificationEventType;
  version: typeof NOTIFICATION_ENVELOPE_VERSION;
  occurred_at: string;
  resource: { type: string; id: string };
  /** Stable per attempt so retries of the same job produce separate events. */
  attempt_id: string;
  /** Keycloak subject. Used as the inbox audience key. */
  recipient_subject: string;
  /** Email. Used as the key for user_settings preferences. */
  recipient_email: string;
  correlation_id?: string;
  data: {
    status: string;
    title: string;
    summary: string;
    href?: string;
  };
}

export type EnvelopeParseResult =
  | { ok: true; envelope: NotificationEnvelope }
  | { ok: false; error: string };

function nonEmptyString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return Number.isFinite(Date.parse(value));
}

/**
 * Validates an untrusted envelope. Unknown fields are dropped rather than
 * stored, so a producer cannot smuggle prompts or tool output into the inbox.
 */
export function parseNotificationEnvelope(input: unknown): EnvelopeParseResult {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "envelope must be an object" };
  }
  const raw = input as Record<string, unknown>;

  if (raw.version !== NOTIFICATION_ENVELOPE_VERSION) {
    return { ok: false, error: `unsupported envelope version: ${String(raw.version)}` };
  }
  if (!isNotificationEventType(raw.type)) {
    return { ok: false, error: `unknown event type: ${String(raw.type)}` };
  }

  const id = nonEmptyString(raw.id, MAX_ID_LENGTH);
  if (!id) return { ok: false, error: "id is required" };

  const attemptId = nonEmptyString(raw.attempt_id, MAX_ID_LENGTH);
  if (!attemptId) return { ok: false, error: "attempt_id is required" };

  const recipient = nonEmptyString(raw.recipient_subject, MAX_ID_LENGTH);
  if (!recipient) return { ok: false, error: "recipient_subject is required" };

  const recipientEmail = nonEmptyString(raw.recipient_email, MAX_ID_LENGTH);
  if (!recipientEmail) return { ok: false, error: "recipient_email is required" };

  if (!isIsoTimestamp(raw.occurred_at)) {
    return { ok: false, error: "occurred_at must be an ISO-8601 timestamp" };
  }

  const resource = raw.resource as Record<string, unknown> | undefined;
  const resourceType = nonEmptyString(resource?.type, 64);
  const resourceId = nonEmptyString(resource?.id, MAX_ID_LENGTH);
  if (!resourceType || !resourceId) {
    return { ok: false, error: "resource.type and resource.id are required" };
  }

  const data = raw.data as Record<string, unknown> | undefined;
  const status = nonEmptyString(data?.status, 64);
  const title = nonEmptyString(data?.title, MAX_TITLE_LENGTH);
  const summary = nonEmptyString(data?.summary, MAX_SUMMARY_LENGTH);
  if (!status || !title || !summary) {
    return { ok: false, error: "data.status, data.title, and data.summary are required" };
  }

  let href: string | undefined;
  if (data?.href !== undefined) {
    // Only same-app relative links, so an envelope cannot inject external URLs.
    if (typeof data.href !== "string" || !data.href.startsWith("/") || data.href.startsWith("//")) {
      return { ok: false, error: "data.href must be a relative path" };
    }
    href = data.href;
  }

  const correlationId = nonEmptyString(raw.correlation_id, MAX_ID_LENGTH) ?? undefined;

  return {
    ok: true,
    envelope: {
      id,
      type: raw.type,
      version: NOTIFICATION_ENVELOPE_VERSION,
      occurred_at: new Date(raw.occurred_at as string).toISOString(),
      resource: { type: resourceType, id: resourceId },
      attempt_id: attemptId,
      recipient_subject: recipient,
      recipient_email: recipientEmail,
      ...(correlationId ? { correlation_id: correlationId } : {}),
      data: {
        status,
        title,
        summary,
        ...(href ? { href } : {}),
      },
    },
  };
}

/**
 * Deterministic key used as the inbox dedupe key. Retries get a new
 * `attempt_id`, so they create a new entry, while redelivery of the same
 * attempt is ignored.
 */
export function notificationEventKey(envelope: NotificationEnvelope, recipient: string): string {
  return [
    envelope.type,
    envelope.resource.type,
    envelope.resource.id,
    envelope.attempt_id,
    recipient,
  ].join(":");
}
