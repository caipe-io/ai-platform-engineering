import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

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

it.each(["web_push", "webex", "slack"])("unsubscribes globally from %s even when its provider is unavailable", async (channel) => {
  const labels: Record<string, string> = { web_push: "Browser web push", webex: "Webex", slack: "Slack" };
  const enabledView = { ...view, global: { channels: { ...view.global.channels, [channel]: true } } };
  global.fetch = jest.fn(async (url, options) => {
    if (options?.method === "PATCH") return response({ saved: true }) as Response;
    if (String(url).endsWith("/channels")) return response({ in_app: true }) as Response;
    return response(enabledView) as Response;
  });
  render(<NotificationDeliverySettings section="delivery" />);
  fireEvent.click(await screen.findByRole("button", { name: `Unsubscribe from all ${labels[channel]}` }));
  expect((fetch as jest.Mock).mock.calls.some((call) => call[1]?.method === "PATCH")).toBe(false);
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: `Unsubscribe from all ${labels[channel]}` }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm unsubscribe" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/notifications/subscriptions", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ channels: { [channel]: false } }) })));
  expect(await screen.findByRole("status")).toHaveTextContent(`Unsubscribed from all ${labels[channel]} notifications.`);
});
it("keeps the unsubscribe dialog open on a rejected preference update", async () => {
  global.fetch = jest.fn(async (url, options) => {
    if (options?.method === "PATCH") return { ok: false, json: async () => ({ success: false, error: "Could not save" }) } as Response;
    if (String(url).endsWith("/channels")) return response({ in_app: true }) as Response;
    return response(view) as Response;
  });
  render(<NotificationDeliverySettings section="delivery" />);
  fireEvent.click(await screen.findByRole("button", { name: "Unsubscribe from all In-app inbox" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm unsubscribe" }));
  await waitFor(() => expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent("Could not save"));
});
