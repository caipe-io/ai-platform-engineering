import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { NotificationDeliverySettings } from "../NotificationDeliverySettings";

const view = {
  global: {
    channels: { in_app: true, web_push: false, webex: false, slack: false },
  },
  webPushPublicKey: null,
  sources: [
    {
      id: "app:example-app",
      label: "Example app",
      subscription: { enabled: false },
      events: [{ id: "report.ready", label: "Report ready", subscription: {} }],
    },
  ],
};
const response = (data: unknown) => ({
  ok: true,
  json: async () => ({ success: true, data }),
});

describe("notification delivery settings", () => {
  beforeEach(() => {
    global.fetch = jest.fn(async (url, options) => {
      if (options?.method === "PATCH")
        return response({ saved: true }) as Response;
      if (String(url).endsWith("/channels"))
        return response({
          in_app: true,
          web_push: false,
          webex: false,
          slack: false,
        }) as Response;
      return response(view) as Response;
    });
  });
  it("shows app-owned types, subscription and external delivery opt-ins", async () => {
    render(<NotificationDeliverySettings />);
    expect(
      await screen.findByRole("switch", { name: "Subscribe to Example app" }),
    ).toHaveAttribute("aria-checked", "false");
    expect(
      screen.getByRole("switch", { name: "Enable Slack" }),
    ).toHaveAttribute("aria-checked", "false");
    expect(
      screen.getByRole("switch", { name: "Enable Browser web push" }),
    ).toBeDisabled();
    expect(screen.getByText("What you follow")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("switch", { name: "Subscribe to Example app" }),
    );
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/notifications/subscriptions",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ sourceId: "app:example-app", enabled: true }),
        }),
      ),
    );
  });
  it("keeps a quiet-hours draft across another save and clears it after saving", async () => {
    let quietHours = { enabled: true, start: "21:00", end: "07:00", timeZone: "UTC" };
    const fetchMock = jest.mocked(fetch);
    fetchMock.mockImplementation(async (url, options) => {
      if (options?.method === "PATCH") {
        const patch = JSON.parse(String(options.body));
        if (patch.quietHours) quietHours = { ...patch.quietHours, timeZone: "Etc/UTC" };
        return response({ saved: true }) as Response;
      }
      if (String(url).endsWith("/channels")) return response({ in_app: true }) as Response;
      return response({ ...view, global: { ...view.global, quietHours } }) as Response;
    });
    render(<NotificationDeliverySettings section="delivery" />);
    const start = await screen.findByLabelText("Quiet hours start");
    expect(start).toHaveValue("21:00");
    fireEvent.change(start, { target: { value: "23:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Pause for 1 hour" }));
    await screen.findByText("Notification preferences saved.");
    expect(start).toHaveValue("23:00");

    fireEvent.click(screen.getByRole("button", { name: "Save quiet hours" }));
    await waitFor(() => expect(screen.getByLabelText("Quiet hours time zone")).toHaveValue("Etc/UTC"));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/notifications/subscriptions",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({
        quietHours: { enabled: true, start: "23:00", end: "07:00", timeZone: "UTC" },
      }) }),
    );
  });

  it("lets a user turn off an unavailable channel", async () => {
    const fetchMock = jest.mocked(fetch);
    fetchMock.mockImplementation(async (url, options) => {
      if (options?.method === "PATCH") return response({ saved: true }) as Response;
      if (String(url).endsWith("/channels")) return response({ in_app: true, slack: false }) as Response;
      return response({ ...view, global: { channels: { ...view.global.channels, slack: true } } }) as Response;
    });
    render(<NotificationDeliverySettings section="delivery" />);
    const channel = await screen.findByRole("switch", { name: "Enable Slack" });
    expect(channel).toHaveAttribute("aria-checked", "true");
    expect(channel).toBeEnabled();
    fireEvent.click(channel);
    await screen.findByText("Notification preferences saved.");
    expect(fetchMock).toHaveBeenCalledWith("/api/notifications/subscriptions", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ channels: { slack: false } }),
    }));
  });

  it("pauses updates without changing channel choices", async () => {
    render(<NotificationDeliverySettings />);
    const buttons = await screen.findAllByRole("button", {
      name: "Pause for 1 hour",
    });
    fireEvent.click(buttons[0]);
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/notifications/subscriptions",
        expect.objectContaining({
          method: "PATCH",
          body: expect.stringContaining("pausedUntil"),
        }),
      ),
    );
  });
});
