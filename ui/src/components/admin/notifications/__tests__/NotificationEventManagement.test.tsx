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

it("requires confirmation before retiring an app event", async () => {
  const appEvent = { ...event, sourceId: "app:example", eventType: "report.ready", label: "Report ready", audience: "recipients" };
  mockFetch.mockResolvedValue(reply([{ id: "app:example", label: "Example app", events: [appEvent] }]));
  render(<NotificationEventManagement />);
  await screen.findByRole("tab", { name: "App events" });
  fireEvent.mouseDown(screen.getByRole("tab", { name: "App events" }), { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("button", { name: "Retire event", hidden: true }));
  expect(mockFetch.mock.calls.some((call) => call[1]?.method === "PATCH")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Cancel", hidden: true }));
  expect(screen.queryByRole("button", { name: "Confirm retirement", hidden: true })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retire event", hidden: true }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm retirement", hidden: true }));
  await waitFor(() => expect(mockFetch).toHaveBeenCalledWith("/api/admin/notifications/events", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ sourceId: "app:example", eventType: "report.ready", revision: 0, action: "retire" }) })));
});
it("hides retired events by default and offers explicit restoration", async () => {
  mockFetch.mockResolvedValue(reply([{ id: "app:example", label: "Example app", events: [{ ...event, sourceId: "app:example", eventType: "report.ready", label: "Report ready", retired: true, revision: 1 }] }]));
  render(<NotificationEventManagement />);
  await screen.findByRole("tab", { name: "App events" });
  fireEvent.mouseDown(screen.getByRole("tab", { name: "App events" }), { button: 0, ctrlKey: false });
  await screen.findByLabelText("Show retired events");
  expect(screen.queryByText("Report ready")).not.toBeInTheDocument();
  fireEvent.click(screen.getByLabelText("Show retired events"));
  fireEvent.click(screen.getByRole("button", { name: "Restore event", hidden: true }));
  await waitFor(() => expect(mockFetch).toHaveBeenCalledWith("/api/admin/notifications/events", expect.objectContaining({ method: "PATCH", body: expect.stringContaining('"action":"restore"') })));
});
it("never offers retirement for built-in platform events", async () => {
  render(<NotificationEventManagement />);
  await screen.findByText("Service degraded");
  expect(screen.queryByRole("button", { name: "Retire event", hidden: true })).not.toBeInTheDocument();
});
