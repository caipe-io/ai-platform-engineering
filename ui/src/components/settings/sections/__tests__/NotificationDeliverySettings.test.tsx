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
