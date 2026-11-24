import {
  channelEnabled,
  quietHoursEnd,
  safeNotificationHref,
} from "@/lib/notifications/channels";

describe("notification channel preferences", () => {
  it("requires an explicit external opt-in and an app subscription", () => {
    expect(channelEnabled("in_app", null, null, null)).toBe(true);
    expect(
      channelEnabled("slack", null, { channels: { slack: true } }, null),
    ).toBe(false);
    expect(channelEnabled("in_app", null, null, null, false)).toBe(false);
    expect(channelEnabled("in_app", null, { enabled: true }, null, false)).toBe(
      true,
    );
  });
  it("honors source/event pauses and per-channel overrides", () => {
    const global = { channels: { slack: true } };
    expect(
      channelEnabled(
        "slack",
        global,
        { channels: { slack: false } },
        { channels: { slack: true } },
      ),
    ).toBe(true);
    expect(
      channelEnabled(
        "slack",
        global,
        { enabled: false },
        { channels: { slack: true } },
      ),
    ).toBe(false);
    expect(
      channelEnabled(
        "slack",
        global,
        null,
        { pausedUntil: "2026-01-02T00:00:00Z" },
        true,
        Date.parse("2026-01-01T00:00:00Z"),
      ),
    ).toBe(false);
    expect(
      channelEnabled(
        "slack",
        global,
        null,
        { pausedUntil: "2026-01-02T00:00:00Z" },
        true,
        Date.parse("2026-01-03T00:00:00Z"),
      ),
    ).toBe(true);
  });
  it("defers quiet hours across midnight and daylight saving changes", () => {
    const preferences = {
      quietHours: {
        enabled: true,
        start: "22:00",
        end: "07:00",
        timeZone: "America/New_York",
      },
    };
    expect(
      quietHoursEnd(
        preferences,
        Date.parse("2026-03-08T06:30:00Z"),
      )?.toISOString(),
    ).toBe("2026-03-08T11:00:00.000Z");
    expect(
      quietHoursEnd(preferences, Date.parse("2026-03-08T17:00:00Z")),
    ).toBeNull();
  });
  it.each([
    "//other.example.test",
    "/\\other.example.test",
    "/\t/other.example.test",
    "https://other.example.test",
  ])("rejects unsafe links: %s", (href) => {
    expect(() => safeNotificationHref(href)).toThrow();
  });
});
