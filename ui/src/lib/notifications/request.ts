import { parseNotificationEnvelope } from "@/lib/notifications/envelope";

export const MAX_REQUEST_RECIPIENTS = 50;

/** A recipient as a producer knows them. The server fills in the missing identifier. */
export interface RecipientRef {
  subject?: string;
  email?: string;
}

export interface NotificationEventRequest {
  /** The envelope without recipient fields. */
  base: Record<string, unknown>;
  recipients: RecipientRef[];
  includeOrgAdmins: boolean;
}

export type NotificationEventRequestResult =
  | { ok: true; request: NotificationEventRequest }
  | { ok: false; error: string };

function optionalString(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Validates a producer request. It carries one event plus who should hear
 * about it. Producers may list explicit recipients, ask for org admins, or
 * both. The older single `recipient_subject`/`recipient_email` pair is still
 * accepted as a one-person list.
 */
export function parseNotificationEventRequest(input: unknown): NotificationEventRequestResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "request must be an object" };
  }
  const raw = input as Record<string, unknown>;
  const {
    recipients: rawRecipients,
    include_org_admins: rawIncludeAdmins,
    recipient_subject: legacySubject,
    recipient_email: legacyEmail,
    ...base
  } = raw;

  if (rawIncludeAdmins !== undefined && typeof rawIncludeAdmins !== "boolean") {
    return { ok: false, error: "include_org_admins must be a boolean" };
  }

  const recipients: RecipientRef[] = [];
  if (rawRecipients !== undefined) {
    if (!Array.isArray(rawRecipients)) return { ok: false, error: "recipients must be an array" };
    if (rawRecipients.length > MAX_REQUEST_RECIPIENTS) {
      return { ok: false, error: `recipients may contain at most ${MAX_REQUEST_RECIPIENTS} entries` };
    }
    for (const entry of rawRecipients) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return { ok: false, error: "each recipient must be an object" };
      }
      const subject = optionalString((entry as Record<string, unknown>).subject);
      const email = optionalString((entry as Record<string, unknown>).email);
      if (subject === null || email === null) {
        return { ok: false, error: "recipient subject and email must be strings" };
      }
      if (!subject && !email) {
        return { ok: false, error: "each recipient needs a subject or an email" };
      }
      recipients.push({ ...(subject ? { subject } : {}), ...(email ? { email } : {}) });
    }
  }

  const legacy = {
    subject: optionalString(legacySubject),
    email: optionalString(legacyEmail),
  };
  if (legacy.subject === null || legacy.email === null) {
    return { ok: false, error: "recipient_subject and recipient_email must be strings" };
  }
  if (legacy.subject || legacy.email) {
    recipients.push({
      ...(legacy.subject ? { subject: legacy.subject } : {}),
      ...(legacy.email ? { email: legacy.email } : {}),
    });
  }

  const includeOrgAdmins = rawIncludeAdmins === true;
  if (recipients.length === 0 && !includeOrgAdmins) {
    return { ok: false, error: "at least one recipient or include_org_admins is required" };
  }

  // Validate the event itself now, so a bad envelope is rejected before any
  // recipient lookup. Placeholder recipient values are replaced per recipient.
  const probe = parseNotificationEnvelope({
    ...base,
    recipient_subject: "validation-placeholder",
    recipient_email: "validation@example.com",
  });
  if (probe.ok === false) return { ok: false, error: probe.error };

  return { ok: true, request: { base, recipients, includeOrgAdmins } };
}
