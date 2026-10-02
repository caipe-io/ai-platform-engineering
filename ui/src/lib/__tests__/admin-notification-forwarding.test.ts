/** @jest-environment node */

const mockGetCollection = jest.fn();
const mockCallSlackBotAdmin = jest.fn();

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

jest.mock("@/lib/slack-bot-admin", () => ({
  callSlackBotAdmin: (...args: unknown[]) => mockCallSlackBotAdmin(...args),
}));

import {
  forwardAdminNotificationToSlack,
  formatAdminNotificationSlackText,
  getAdminNotificationForwardingConfig,
  normalizeAdminNotificationForwardingConfig,
} from "@/lib/admin-notification-forwarding.server";

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.NEXTAUTH_URL;
});

describe("normalizeAdminNotificationForwardingConfig", () => {
  it("defaults to disabled with no channel and no users", () => {
    expect(normalizeAdminNotificationForwardingConfig(undefined)).toEqual({
      enabled: false,
      channel_id: null,
      channel_name: null,
      ping_user_ids: [],
    });
  });

  it("accepts a valid config", () => {
    const result = normalizeAdminNotificationForwardingConfig({
      enabled: true,
      channel_id: "C0123456789",
      channel_name: "platform-alerts",
      ping_user_ids: ["U0123456789", "S0123456789"],
    });
    expect(result).toEqual({
      enabled: true,
      channel_id: "C0123456789",
      channel_name: "platform-alerts",
      ping_user_ids: ["U0123456789", "S0123456789"],
    });
  });

  it("drops invalid channel/user ids silently in non-strict mode", () => {
    const result = normalizeAdminNotificationForwardingConfig({
      enabled: false,
      channel_id: "not-a-channel",
      ping_user_ids: ["bad", "U0123456789"],
    });
    expect(result.channel_id).toBeNull();
    expect(result.ping_user_ids).toEqual(["U0123456789"]);
  });

  it("dedupes ping_user_ids and caps at 25 in non-strict mode", () => {
    const ids = Array.from({ length: 30 }, (_, i) => `U0${String(i).padStart(9, "0")}`);
    const result = normalizeAdminNotificationForwardingConfig({
      ping_user_ids: [...ids, ids[0]],
    });
    expect(result.ping_user_ids).toHaveLength(25);
  });

  it("clears channel_name when channel_id is invalid/absent", () => {
    const result = normalizeAdminNotificationForwardingConfig({
      channel_name: "stale-name",
    });
    expect(result.channel_name).toBeNull();
  });

  it("throws in strict mode for an invalid channel id", () => {
    expect(() =>
      normalizeAdminNotificationForwardingConfig(
        { channel_id: "not-a-channel" },
        { strict: true },
      ),
    ).toThrow(/channel_id/);
  });

  it("throws in strict mode for an invalid user id", () => {
    expect(() =>
      normalizeAdminNotificationForwardingConfig(
        { ping_user_ids: ["bad-id"] },
        { strict: true },
      ),
    ).toThrow(/ping_user_ids/);
  });

  it("throws in strict mode when enabled without a channel", () => {
    expect(() =>
      normalizeAdminNotificationForwardingConfig({ enabled: true }, { strict: true }),
    ).toThrow(/channel is required/);
  });

  it("throws in strict mode when more than 25 ping_user_ids are provided", () => {
    const ids = Array.from({ length: 26 }, (_, i) => `U0${String(i).padStart(9, "0")}`);
    expect(() =>
      normalizeAdminNotificationForwardingConfig({ ping_user_ids: ids }, { strict: true }),
    ).toThrow(/25 entries/);
  });

  it("accepts enabled with a valid channel in strict mode", () => {
    const result = normalizeAdminNotificationForwardingConfig(
      { enabled: true, channel_id: "C0123456789" },
      { strict: true },
    );
    expect(result.enabled).toBe(true);
    expect(result.channel_id).toBe("C0123456789");
  });
});

describe("getAdminNotificationForwardingConfig", () => {
  it("returns the default when nothing is stored", async () => {
    mockGetCollection.mockResolvedValue({ findOne: jest.fn().mockResolvedValue(null) });

    const result = await getAdminNotificationForwardingConfig();

    expect(result).toEqual({
      enabled: false,
      channel_id: null,
      channel_name: null,
      ping_user_ids: [],
    });
  });

  it("normalizes a stored config", async () => {
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({
        _id: "platform_settings",
        slack_admin_notification_forwarding: {
          enabled: true,
          channel_id: "C0123456789",
          channel_name: "platform-alerts",
          ping_user_ids: ["U0123456789"],
        },
      }),
    });

    const result = await getAdminNotificationForwardingConfig();

    expect(result).toEqual({
      enabled: true,
      channel_id: "C0123456789",
      channel_name: "platform-alerts",
      ping_user_ids: ["U0123456789"],
    });
  });
});

describe("formatAdminNotificationSlackText", () => {
  const baseConfig = {
    enabled: true,
    channel_id: "C0123456789",
    channel_name: null,
    ping_user_ids: [] as string[],
  };

  it("includes the title, message, and emoji for each severity", () => {
    for (const [severity, emoji] of [
      ["info", ":information_source:"],
      ["success", ":white_check_mark:"],
      ["warning", ":warning:"],
      ["error", ":rotating_light:"],
    ] as const) {
      const text = formatAdminNotificationSlackText(
        { title: "Approval needed", message: "Jane submitted a request.", severity },
        baseConfig,
      );
      expect(text).toContain(emoji);
      expect(text).toContain("*Approval needed*");
      expect(text).toContain("Jane submitted a request.");
    }
  });

  it("mentions users and subteams", () => {
    const text = formatAdminNotificationSlackText(
      { title: "t", message: "m", severity: "info" },
      { ...baseConfig, ping_user_ids: ["U0123456789", "S0123456789"] },
    );
    expect(text).toContain("<@U0123456789>");
    expect(text).toContain("<!subteam^S0123456789>");
  });

  it("escapes Slack special characters in title and message", () => {
    const text = formatAdminNotificationSlackText(
      { title: "A & B < C", message: "x > y & z", severity: "info" },
      baseConfig,
    );
    expect(text).toContain("A &amp; B &lt; C");
    expect(text).toContain("x &gt; y &amp; z");
  });

  it("appends an absolute link built from NEXTAUTH_URL", () => {
    process.env.NEXTAUTH_URL = "https://caipe.example.com";
    const text = formatAdminNotificationSlackText(
      {
        title: "t",
        message: "m",
        severity: "info",
        href: "/admin/security/approvals?request=abc",
      },
      baseConfig,
    );
    expect(text).toContain(
      "<https://caipe.example.com/admin/security/approvals?request=abc|Open in CAIPE>",
    );
  });

  it("omits the link line when there is no href", () => {
    const text = formatAdminNotificationSlackText(
      { title: "t", message: "m", severity: "info" },
      baseConfig,
    );
    expect(text).not.toContain("Open in CAIPE");
  });

  it("includes an escaped source label when present", () => {
    const text = formatAdminNotificationSlackText(
      { title: "t", message: "m", severity: "info", sourceLabel: "Platform & Ops" },
      baseConfig,
    );
    expect(text).toContain("_Source: Platform &amp; Ops_");
  });

  it("omits the source label line when absent", () => {
    const text = formatAdminNotificationSlackText(
      { title: "t", message: "m", severity: "info" },
      baseConfig,
    );
    expect(text).not.toContain("Source:");
  });

  it("truncates to 4000 characters", () => {
    const text = formatAdminNotificationSlackText(
      { title: "t", message: "m".repeat(5000), severity: "info" },
      baseConfig,
    );
    expect(text.length).toBe(4000);
  });
});

describe("forwardAdminNotificationToSlack", () => {
  const enabledConfig = {
    enabled: true,
    channel_id: "C0123456789",
    channel_name: null,
    ping_user_ids: ["U0123456789"],
  };

  it("does nothing when forwarding is disabled", async () => {
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({
        slack_admin_notification_forwarding: { ...enabledConfig, enabled: false },
      }),
    });

    await forwardAdminNotificationToSlack({ title: "t", message: "m", severity: "info" });

    expect(mockCallSlackBotAdmin).not.toHaveBeenCalled();
  });

  it("does nothing when enabled but no channel is configured", async () => {
    mockGetCollection.mockResolvedValue({ findOne: jest.fn().mockResolvedValue(null) });

    await forwardAdminNotificationToSlack({ title: "t", message: "m", severity: "info" });

    expect(mockCallSlackBotAdmin).not.toHaveBeenCalled();
  });

  it("posts to Slack with the configured channel and formatted text", async () => {
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({
        slack_admin_notification_forwarding: enabledConfig,
      }),
    });
    mockCallSlackBotAdmin.mockResolvedValue({ channel_id: "C0123456789", message_ts: "123.456" });

    await forwardAdminNotificationToSlack({
      title: "Approval needed",
      message: "Jane submitted a request.",
      severity: "warning",
    });

    expect(mockCallSlackBotAdmin).toHaveBeenCalledWith(
      "/admin/slack/notifications",
      expect.objectContaining({
        method: "POST",
        body: expect.objectContaining({
          channel_id: "C0123456789",
          text: expect.stringContaining("Approval needed"),
        }),
      }),
    );
  });

  it("swallows and logs errors instead of throwing", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({
        slack_admin_notification_forwarding: enabledConfig,
      }),
    });
    mockCallSlackBotAdmin.mockRejectedValue(new Error("Slack is down"));

    await expect(
      forwardAdminNotificationToSlack({ title: "t", message: "m", severity: "info" }),
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      "[admin-notification-forwarding] forward failed",
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });
});
