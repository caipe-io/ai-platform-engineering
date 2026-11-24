/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { AreaNotificationToggle } from "../AreaNotificationToggle";

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as Response;
}

function view(enabled: Record<string, boolean>) {
  return {
    events: Object.entries(enabled).map(([type, on]) => ({ type, category: type.split(".")[0], enabled: on, explicit: false })),
  };
}

const ALL_WORKFLOW_ON = view({
  "workflow.completed": true,
  "workflow.failed": true,
  "workflow.requires_input": true,
  "workflow.started": false,
});

function patches(fetchMock: jest.Mock): unknown[] {
  return fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === "PATCH")
    .map(([, init]) => JSON.parse((init as RequestInit).body as string));
}

describe("AreaNotificationToggle", () => {
  it("shows the area label and reflects the stored preference", async () => {
    global.fetch = jest.fn(async () => jsonResponse({ success: true, data: ALL_WORKFLOW_ON })) as typeof fetch;
    render(<AreaNotificationToggle area="workflow" />);

    const toggle = await screen.findByRole("switch", { name: "Notify me about workflows" });
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    expect(screen.getByRole("link", { name: "All notification settings" })).toHaveAttribute(
      "href",
      "/settings/notifications",
    );
  });

  it("is off when any event in its area is off", async () => {
    global.fetch = jest.fn(async () =>
      jsonResponse({
        success: true,
        data: view({ "workflow.completed": true, "workflow.failed": false, "workflow.requires_input": true }),
      }),
    ) as typeof fetch;
    render(<AreaNotificationToggle area="workflow" />);

    expect(await screen.findByRole("switch", { name: "Notify me about workflows" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("turning it off writes explicit false for each of the area's events and leaves others alone", async () => {
    const fetchMock = jest.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return jsonResponse({
          success: true,
          data: view({
            "workflow.completed": false,
            "workflow.failed": false,
            "workflow.requires_input": false,
            "workflow.started": false,
          }),
        });
      }
      return jsonResponse({ success: true, data: ALL_WORKFLOW_ON });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<AreaNotificationToggle area="workflow" />);

    const toggle = await screen.findByRole("switch", { name: "Notify me about workflows" });
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    fireEvent.click(toggle);

    await waitFor(() => expect(screen.getByText("Saved")).toBeInTheDocument());
    expect(patches(fetchMock)).toEqual([
      {
        events: {
          "workflow.completed": false,
          "workflow.failed": false,
          "workflow.requires_input": false,
        },
      },
    ]);
    expect(screen.getByRole("switch", { name: "Notify me about workflows" })).toHaveAttribute("aria-checked", "false");
  });

  it("controls only completion and failure events for ingestion and agent areas", async () => {
    const fetchMock = jest.fn(async (_url: unknown, init?: RequestInit) =>
      init?.method === "PATCH"
        ? jsonResponse({ success: true, data: view({ "ingestion.completed": true, "ingestion.failed": true }) })
        : jsonResponse({ success: true, data: view({ "ingestion.completed": false, "ingestion.failed": false }) }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<AreaNotificationToggle area="ingestion" />);

    fireEvent.click(await screen.findByRole("switch", { name: "Notify me about ingestion" }));

    await waitFor(() => expect(patches(fetchMock)).toHaveLength(1));
    expect(patches(fetchMock)[0]).toEqual({ events: { "ingestion.completed": true, "ingestion.failed": true } });
  });

  it("shows an error and keeps the previous state when saving fails", async () => {
    const fetchMock = jest.fn(async (_url: unknown, init?: RequestInit) =>
      init?.method === "PATCH"
        ? jsonResponse({ success: false, error: "Database unavailable" }, false)
        : jsonResponse({ success: true, data: ALL_WORKFLOW_ON }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<AreaNotificationToggle area="workflow" />);

    const toggle = await screen.findByRole("switch", { name: "Notify me about workflows" });
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    fireEvent.click(toggle);

    expect(await screen.findByText("Database unavailable")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Notify me about workflows" })).toHaveAttribute("aria-checked", "true");
  });

  it("shows a load error instead of crashing when the settings cannot be read", async () => {
    global.fetch = jest.fn(async () => jsonResponse({ success: false, error: "Not signed in" }, false)) as typeof fetch;
    render(<AreaNotificationToggle area="agent" />);

    expect(await screen.findByText("Not signed in")).toBeInTheDocument();
  });

  it("does not crash when the response has an unexpected shape", async () => {
    global.fetch = jest.fn(async () => jsonResponse({ success: true, data: { notifications: {} } })) as typeof fetch;
    render(<AreaNotificationToggle area="agent" />);

    expect(await screen.findByText("Unexpected response")).toBeInTheDocument();
  });
});
