/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { EventNotificationSettings } from "../EventNotificationSettings";

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as Response;
}

const baseView = {
  categories: ["ingestion", "workflow", "agent", "platform"],
  events: [
    { type: "workflow.completed", category: "workflow", enabled: true, explicit: false },
    { type: "workflow.failed", category: "workflow", enabled: false, explicit: true },
    { type: "workflow.started", category: "workflow", enabled: false, explicit: false },
    { type: "ingestion.completed", category: "ingestion", enabled: true, explicit: false },
  ],
  preferences: { categories: {}, events: { "workflow.failed": false } },
};

function viewWith(overrides: Partial<typeof baseView>): typeof baseView {
  return { ...baseView, ...overrides };
}

function patchCalls(fetchMock: jest.Mock): unknown[] {
  return fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === "PATCH")
    .map(([, init]) => JSON.parse((init as RequestInit).body as string));
}

describe("EventNotificationSettings", () => {
  it("shows a loading state, then each category with its events", async () => {
    global.fetch = jest.fn(async () => jsonResponse({ success: true, data: baseView })) as typeof fetch;
    render(<EventNotificationSettings />);

    expect(screen.getByText(/Loading event notification settings/i)).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Workflows" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Knowledge ingestion" })).toBeInTheDocument();
    expect(screen.getByText("Workflow completed")).toBeInTheDocument();
    expect(screen.getByText("Workflow failed")).toBeInTheDocument();
  });

  it("marks inherited events as Default and offers reset only on explicit ones", async () => {
    global.fetch = jest.fn(async () => jsonResponse({ success: true, data: baseView })) as typeof fetch;
    render(<EventNotificationSettings />);
    await screen.findByText("Workflow completed");

    const completed = screen.getByText("Workflow completed").closest("li") as HTMLElement;
    const failed = screen.getByText("Workflow failed").closest("li") as HTMLElement;
    expect(within(completed).getByText("Default")).toBeInTheDocument();
    expect(within(completed).queryByRole("button", { name: "Reset to default" })).toBeNull();
    expect(within(failed).queryByText("Default")).toBeNull();
    expect(within(failed).getByRole("button", { name: "Reset to default" })).toBeInTheDocument();
  });

  it("saves an event toggle and updates the switch from the server response", async () => {
    const fetchMock = jest.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return jsonResponse({
          success: true,
          data: viewWith({
            events: baseView.events.map((row) =>
              row.type === "workflow.started" ? { ...row, enabled: true, explicit: true } : row,
            ),
            preferences: { categories: {}, events: { "workflow.failed": false, "workflow.started": true } },
          }),
        });
      }
      return jsonResponse({ success: true, data: baseView });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<EventNotificationSettings />);

    const toggle = await screen.findByRole("switch", { name: "Workflow started" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);

    await waitFor(() => expect(screen.getByRole("switch", { name: "Workflow started" })).toHaveAttribute("aria-checked", "true"));
    expect(patchCalls(fetchMock)).toEqual([{ events: { "workflow.started": true } }]);
    expect(screen.getByText("All changes saved.")).toBeInTheDocument();
  });

  it("resets an event to its default by sending null", async () => {
    const fetchMock = jest.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return jsonResponse({
          success: true,
          data: viewWith({
            events: baseView.events.map((row) =>
              row.type === "workflow.failed" ? { ...row, enabled: true, explicit: false } : row,
            ),
            preferences: { categories: {}, events: {} },
          }),
        });
      }
      return jsonResponse({ success: true, data: baseView });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<EventNotificationSettings />);

    const failed = (await screen.findByText("Workflow failed")).closest("li") as HTMLElement;
    fireEvent.click(within(failed).getByRole("button", { name: "Reset to default" }));

    await waitFor(() => expect(patchCalls(fetchMock)).toEqual([{ events: { "workflow.failed": null } }]));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Reset to default" })).toBeNull());
  });

  it("category switch turns a mixed category fully on and clears explicit event choices", async () => {
    const fetchMock = jest.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return jsonResponse({ success: true, data: viewWith({}) });
      }
      return jsonResponse({ success: true, data: baseView });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<EventNotificationSettings />);

    fireEvent.click(await screen.findByRole("switch", { name: "Workflows: all events" }));

    await waitFor(() => expect(patchCalls(fetchMock)).toHaveLength(1));
    // The workflow category is mixed, so the switch turns every event on.
    expect(patchCalls(fetchMock)[0]).toEqual({
      categories: { workflow: true },
      events: { "workflow.failed": null },
    });
  });

  it("shows a save error with retry, and retry resends the same change", async () => {
    let failNextSave = true;
    const fetchMock = jest.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        if (failNextSave) {
          failNextSave = false;
          return jsonResponse({ success: false, error: "Database unavailable" }, false);
        }
        return jsonResponse({ success: true, data: viewWith({}) });
      }
      return jsonResponse({ success: true, data: baseView });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<EventNotificationSettings />);

    fireEvent.click(await screen.findByRole("switch", { name: "Workflow started" }));

    expect(await screen.findByText("Database unavailable")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(screen.getByText("All changes saved.")).toBeInTheDocument());
    expect(patchCalls(fetchMock)).toEqual([
      { events: { "workflow.started": true } },
      { events: { "workflow.started": true } },
    ]);
  });

  it("shows a load error instead of crashing on an unexpected response", async () => {
    global.fetch = jest.fn(async () => jsonResponse({ success: true, data: { notifications: {} } })) as typeof fetch;
    render(<EventNotificationSettings />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/Unexpected response/);
  });

  it("shows a load error when the request fails", async () => {
    global.fetch = jest.fn(async () => jsonResponse({ success: false, error: "Not signed in" }, false)) as typeof fetch;
    render(<EventNotificationSettings />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Not signed in");
  });

  describe("send test", () => {
    function mockFetch(testResponse: () => Response) {
      const fetchMock = jest.fn(async (url: unknown, init?: RequestInit) => {
        if (String(url).endsWith("/test")) return testResponse();
        if (init?.method === "PATCH") return jsonResponse({ success: true, data: baseView });
        return jsonResponse({ success: true, data: baseView });
      });
      global.fetch = fetchMock as unknown as typeof fetch;
      return fetchMock;
    }

    function testCalls(fetchMock: jest.Mock): unknown[] {
      return fetchMock.mock.calls
        .filter(([url]) => String(url).endsWith("/test"))
        .map(([, init]) => JSON.parse((init as RequestInit).body as string));
    }

    it("sends a test for that event and refreshes the bell", async () => {
      const fetchMock = mockFetch(() => jsonResponse({ success: true, data: { outcome: "delivered" } }));
      const refresh = jest.fn();
      window.addEventListener("in-app-notifications:refresh", refresh);
      render(<EventNotificationSettings />);

      const row = (await screen.findByText("Workflow completed")).closest("li") as HTMLElement;
      fireEvent.click(within(row).getByRole("button", { name: "Send test" }));

      expect(await within(row).findByText("Sent. It appears in your notification bell.")).toBeInTheDocument();
      expect(testCalls(fetchMock)).toEqual([{ type: "workflow.completed" }]);
      expect(refresh).toHaveBeenCalledTimes(1);
      window.removeEventListener("in-app-notifications:refresh", refresh);
    });

    it("says so when the event is turned off, and does not refresh the bell", async () => {
      mockFetch(() => jsonResponse({ success: true, data: { outcome: "disabled" } }));
      const refresh = jest.fn();
      window.addEventListener("in-app-notifications:refresh", refresh);
      render(<EventNotificationSettings />);

      const row = (await screen.findByText("Workflow failed")).closest("li") as HTMLElement;
      fireEvent.click(within(row).getByRole("button", { name: "Send test" }));

      expect(await within(row).findByText("Skipped, because this event is turned off for you.")).toBeInTheDocument();
      expect(refresh).not.toHaveBeenCalled();
      window.removeEventListener("in-app-notifications:refresh", refresh);
    });

    it("shows the server's message when the test fails or is rate limited", async () => {
      mockFetch(() => jsonResponse({ success: false, error: "Too many test notifications. Try again in a minute." }, false));
      render(<EventNotificationSettings />);

      const row = (await screen.findByText("Workflow completed")).closest("li") as HTMLElement;
      fireEvent.click(within(row).getByRole("button", { name: "Send test" }));

      expect(await within(row).findByRole("alert")).toHaveTextContent("Too many test notifications");
    });
  });
});
