import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NotificationEventManagement } from "../NotificationEventManagement";
const event = { sourceId: "platform", eventType: "service.degraded", label: "Service degraded", description: "Example service health", enabled: true, defaultEnabled: true, audience: "organization_admins", allowedChannels: ["in_app"], revision: 0, locked: false };
const sources = [{ id: "platform", label: "Platform", events: [event] }, { id: "app:example", label: "Example app", events: [] }];
const mockFetch = jest.fn();
const reply = (data: unknown) => ({ ok: true, json: async () => ({ success: true, data }) });
beforeEach(() => { jest.clearAllMocks(); global.fetch = mockFetch; mockFetch.mockResolvedValue(reply(sources)); });
it("shows the enforced audience and saves a revisioned operator policy", async () => {
  render(<NotificationEventManagement />);
  await screen.findByText("Service degraded");
  expect(screen.getByLabelText("Audience")).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Label"), { target: { value: "Example health" } });
  fireEvent.click(screen.getByRole("button", { name: "Save event", hidden: true }));
  await waitFor(() => expect(mockFetch).toHaveBeenCalledWith("/api/admin/notifications/events", expect.objectContaining({ method: "PATCH", body: expect.stringContaining('"label":"Example health"') })));
  const body = JSON.parse(mockFetch.mock.calls.find((call) => call[1]?.method === "PATCH")[1].body);
  expect(body).toMatchObject({ revision: 0, audience: "organization_admins" });
  expect(body).not.toHaveProperty("locked");
});
it("registers types only under the selected installed app", async () => {
  render(<NotificationEventManagement />);
  await screen.findByText("Service degraded");
  fireEvent.mouseDown(screen.getByRole("tab", { name: "App events" }), { button: 0, ctrlKey: false });
  await screen.findByLabelText("Event ID");
  fireEvent.change(screen.getByLabelText("Event ID"), { target: { value: "report.ready" } });
  fireEvent.change(screen.getByLabelText("Event label"), { target: { value: "Report ready" } });
  fireEvent.click(screen.getByRole("button", { name: "Register event" }));
  await waitFor(() => expect(mockFetch).toHaveBeenCalledWith("/api/admin/notifications/events", expect.objectContaining({ method: "POST", body: JSON.stringify({ sourceId: "app:example", event: { id: "report.ready", label: "Report ready", description: "" } }) })));
});
it("keeps approval audiences and required inbox delivery read-only", async () => {
  mockFetch.mockResolvedValue(reply([{ id: "platform", label: "Platform", events: [{ ...event, eventType: "approval.requested", label: "Approval requested", audience: "approval_reviewers", locked: true }] }]));
  render(<NotificationEventManagement />);
  await screen.findByText("Approval requested");
  expect(screen.getByLabelText("Audience")).toBeDisabled();
  expect(screen.getByLabelText("Enable this event")).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Save event", hidden: true })).not.toBeInTheDocument();
});
it("prevents writes during an admin preview", async () => {
  render(<NotificationEventManagement readOnly />);
  await screen.findByText("Service degraded");
  expect(screen.getByRole("button", { name: "Save event", hidden: true })).toBeDisabled();
});
