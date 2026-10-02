import { ApiError } from "@/lib/api-error";
import { getConfig } from "@/lib/config";
import { getCollection } from "@/lib/mongodb";
import { originFromNextAuthUrl } from "@/lib/request-origin";
import { callSlackBotAdmin } from "@/lib/slack-bot-admin";
import type { AdminNotificationForwardingConfig } from "@/types/admin-notification-forwarding";
import type { InAppNotificationSeverity } from "@/types/in-app-notification";

// Not imported from @/lib/platform-default-agent: that module pulls in
// @/lib/api-middleware -> next/server, which breaks in test environments
// without the Fetch API globals (same reason rbac/onboarding-defaults.ts and
// server/platform-llm.server.ts each keep their own copy of this literal).
const PLATFORM_CONFIG_ID = "platform_settings";

const CHANNEL_ID_PATTERN = /^[CG][A-Z0-9]{8,}$/;
const USER_ID_PATTERN = /^[UWS][A-Z0-9]{8,}$/;
const MAX_PING_USER_IDS = 25;
const SLACK_TEXT_MAX_LENGTH = 4000;

const SEVERITY_EMOJI: Record<InAppNotificationSeverity, string> = {
  info: ":information_source:",
  success: ":white_check_mark:",
  warning: ":bell:",
  error: ":rotating_light:",
};

const DEFAULT_CONFIG: AdminNotificationForwardingConfig = {
  enabled: false,
  channel_id: null,
  channel_name: null,
  ping_user_ids: [],
};

interface PlatformConfigDoc {
  slack_admin_notification_forwarding?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalize an admin-notification-forwarding config.
 *
 * Non-strict mode (reads) drops invalid entries silently so a stale/edited
 * Mongo document never breaks the GET endpoint. Strict mode (writes) throws
 * `ApiError(400)` so an admin never silently saves an unusable config (e.g.
 * enabling forwarding with no channel selected).
 */
export function normalizeAdminNotificationForwardingConfig(
  input: unknown,
  options: { strict?: boolean } = {},
): AdminNotificationForwardingConfig {
  const strict = options.strict === true;
  const source = isRecord(input) ? input : {};

  const enabled = source.enabled === true;

  let channelId: string | null = null;
  if (typeof source.channel_id === "string" && source.channel_id.trim()) {
    const trimmed = source.channel_id.trim();
    if (CHANNEL_ID_PATTERN.test(trimmed)) {
      channelId = trimmed;
    } else if (strict) {
      throw new ApiError(
        "channel_id is not a valid Slack channel id",
        400,
        "INVALID_ADMIN_NOTIFICATION_FORWARDING",
      );
    }
  } else if (strict && source.channel_id != null && typeof source.channel_id !== "string") {
    throw new ApiError(
      "channel_id must be a string or null",
      400,
      "INVALID_ADMIN_NOTIFICATION_FORWARDING",
    );
  }

  const channelName =
    typeof source.channel_name === "string" && source.channel_name.trim()
      ? source.channel_name.trim()
      : null;

  const rawUserIds = Array.isArray(source.ping_user_ids) ? source.ping_user_ids : [];
  const seen = new Set<string>();
  const pingUserIds: string[] = [];
  for (const rawId of rawUserIds) {
    if (typeof rawId !== "string") {
      if (strict) {
        throw new ApiError(
          "ping_user_ids must be an array of strings",
          400,
          "INVALID_ADMIN_NOTIFICATION_FORWARDING",
        );
      }
      continue;
    }
    const trimmed = rawId.trim();
    if (!USER_ID_PATTERN.test(trimmed)) {
      if (strict) {
        throw new ApiError(
          `ping_user_ids contains an invalid Slack id: ${trimmed}`,
          400,
          "INVALID_ADMIN_NOTIFICATION_FORWARDING",
        );
      }
      continue;
    }
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    pingUserIds.push(trimmed);
  }
  if (pingUserIds.length > MAX_PING_USER_IDS) {
    if (strict) {
      throw new ApiError(
        `ping_user_ids must not exceed ${MAX_PING_USER_IDS} entries`,
        400,
        "INVALID_ADMIN_NOTIFICATION_FORWARDING",
      );
    }
    pingUserIds.length = MAX_PING_USER_IDS;
  }

  if (strict && enabled && !channelId) {
    throw new ApiError(
      "A Slack channel is required to enable forwarding.",
      400,
      "INVALID_ADMIN_NOTIFICATION_FORWARDING",
    );
  }

  return {
    enabled,
    channel_id: channelId,
    channel_name: channelId ? channelName : null,
    ping_user_ids: pingUserIds,
  };
}

export async function getAdminNotificationForwardingConfig(): Promise<AdminNotificationForwardingConfig> {
  const collection = await getCollection<PlatformConfigDoc>("platform_config");
  const doc = await collection.findOne({ _id: PLATFORM_CONFIG_ID } as never);
  if (!doc?.slack_admin_notification_forwarding) return DEFAULT_CONFIG;
  return normalizeAdminNotificationForwardingConfig(doc.slack_admin_notification_forwarding);
}

function escapeSlackText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function slackMention(id: string): string {
  return id.startsWith("S") ? `<!subteam^${id}>` : `<@${id}>`;
}

function absoluteNotificationLink(href: string | undefined): string | null {
  if (!href) return null;
  const origin = originFromNextAuthUrl();
  if (!origin) return null;
  try {
    return new URL(href, origin).toString();
  } catch {
    return null;
  }
}

export interface AdminNotificationForwardInput {
  title: string;
  message: string;
  href?: string;
  severity: InAppNotificationSeverity;
  sourceLabel?: string;
}

export function formatAdminNotificationSlackText(
  input: AdminNotificationForwardInput,
  config: AdminNotificationForwardingConfig,
): string {
  const lines: string[] = [];

  const mentions = config.ping_user_ids.map(slackMention).join(" ");
  const emoji = SEVERITY_EMOJI[input.severity] ?? SEVERITY_EMOJI.info;
  const headerParts = [mentions, emoji].filter(Boolean);
  if (headerParts.length > 0) lines.push(headerParts.join(" "));

  lines.push(`*${escapeSlackText(input.title)}*`);
  if (input.message.trim()) lines.push(escapeSlackText(input.message));
  if (input.sourceLabel?.trim()) lines.push(`_Source: ${escapeSlackText(input.sourceLabel.trim())}_`);

  const link = absoluteNotificationLink(input.href);
  if (link) lines.push(`<${link}|Open in ${escapeSlackText(getConfig("appName"))}>`);

  const text = lines.filter(Boolean).join("\n");
  return text.length > SLACK_TEXT_MAX_LENGTH ? text.slice(0, SLACK_TEXT_MAX_LENGTH) : text;
}

/**
 * Forward an admin-targeted in-app notification to Slack, if configured.
 *
 * Fire-and-forget by design: a Slack outage or misconfiguration must never
 * break in-app notification delivery, so every failure is swallowed here
 * after logging.
 */
export async function forwardAdminNotificationToSlack(
  input: AdminNotificationForwardInput,
): Promise<void> {
  try {
    const config = await getAdminNotificationForwardingConfig();
    if (!config.enabled || !config.channel_id) return;
    await callSlackBotAdmin("/admin/slack/notifications", {
      method: "POST",
      body: {
        channel_id: config.channel_id,
        text: formatAdminNotificationSlackText(input, config),
      },
    });
  } catch (error) {
    console.error("[admin-notification-forwarding] forward failed", error);
  }
}
