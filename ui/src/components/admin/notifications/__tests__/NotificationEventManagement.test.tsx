import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NotificationEventManagement } from "../NotificationEventManagement";
const event = { sourceId: "platform", eventType: "service.degraded", label: "Service degraded", description: "Example service health", enabled: true, defaultEnabled: true, audience: "organization_admins", allowedChannels: ["in_app"], revision: 0, locked: false };
const sources = [{ id: "platform", label: "Platform", events: [event] }, { id: "app:example", label: "Example app", events: [] }];
const mockFetch = jest.fn();
const reply = (data: unknown) => ({ ok: true, json: async () => ({ success: true, data }) });
beforeEach(() => { jest.clearAllMocks(); global.fetch = mockFetch; mockFetch.mockResolvedValue(reply(sources)); });
it("shows the enforced audience and saves a revisioned operator policy", async () => {
  render(<NotificationEventManagement />);
  await screen.findByText("Service degraded");
  fireEvent.click(screen.getByRole("button", { name: "Edit Service degraded" }));
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
  fireEvent.click(screen.getByRole("button", { name: "Register event" }));
  await screen.findByLabelText("Event ID");
  fireEvent.change(screen.getByLabelText("Event ID"), { target: { value: "report.ready" } });
  fireEvent.change(screen.getByLabelText("Event label"), { target: { value: "Report ready" } });
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Register event" }));
  await waitFor(() => expect(mockFetch).toHaveBeenCalledWith("/api/admin/notifications/events", expect.objectContaining({ method: "POST", body: JSON.stringify({ sourceId: "app:example", event: { id: "report.ready", label: "Report ready", description: "" } }) })));
});
it("keeps approval audiences and required inbox delivery read-only", async () => {
  mockFetch.mockResolvedValue(reply([{ id: "platform", label: "Platform", events: [{ ...event, eventType: "approval.requested", label: "Approval requested", audience: "approval_reviewers", locked: true }] }]));
  render(<NotificationEventManagement />);
  await screen.findByText("Approval requested");
  fireEvent.click(screen.getByRole("button", { name: "Edit Approval requested" }));
  expect(screen.getByLabelText("Audience")).toBeDisabled();
  expect(screen.getByLabelText("Enable this event")).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Save event", hidden: true })).not.toBeInTheDocument();
});
it("prevents writes during an admin preview", async () => {
  render(<NotificationEventManagement readOnly />);
  await screen.findByText("Service degraded");
  fireEvent.click(screen.getByRole("button", { name: "Edit Service degraded" }));
  expect(screen.getByRole("button", { name: "Save event", hidden: true })).toBeDisabled();
});

it("requires confirmation before retiring an app event", async () => {
  const appEvent = { ...event, sourceId: "app:example", eventType: "report.ready", label: "Report ready", audience: "recipients" };
  mockFetch.mockResolvedValue(reply([{ id: "app:example", label: "Example app", events: [appEvent] }]));
  render(<NotificationEventManagement />);
  await screen.findByRole("tab", { name: "App events" });
  fireEvent.mouseDown(screen.getByRole("tab", { name: "App events" }), { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("button", { name: "Retire Report ready" }));
  expect(mockFetch.mock.calls.some((call) => call[1]?.method === "PATCH")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Cancel", hidden: true }));
  expect(screen.queryByRole("button", { name: "Confirm retirement", hidden: true })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retire Report ready" }));
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
  fireEvent.click(screen.getByRole("button", { name: "Restore Report ready" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Restore event" }));
  await waitFor(() => expect(mockFetch).toHaveBeenCalledWith("/api/admin/notifications/events", expect.objectContaining({ method: "PATCH", body: expect.stringContaining('"action":"restore"') })));
});
it("never offers retirement for built-in platform events", async () => {
  render(<NotificationEventManagement />);
  await screen.findByText("Service degraded");
  expect(screen.queryByRole("button", { name: "Retire Report ready" })).not.toBeInTheDocument();
});

it("keeps grouped row actions visible and discards cancelled edits", async () => {
  render(<NotificationEventManagement />);
  await screen.findByRole("region", { name: "service events" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Edit Service degraded" }));
  fireEvent.change(screen.getByLabelText("Label"), { target: { value: "Unsaved label" } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Edit Service degraded" }));
  expect(screen.getByLabelText("Label")).toHaveValue("Service degraded");
  expect(mockFetch.mock.calls.some((call) => call[1]?.method === "PATCH")).toBe(false);
});

it.each([true, false])("changes enablement from the row with revision guards (enabled=%s)", async (enabled) => {
  const current = { ...event, enabled, revision: 3 };
  const updated = { ...current, enabled: !enabled, revision: 4 };
  mockFetch.mockResolvedValue(reply([{ id: "platform", label: "Platform", events: [current] }]));
  render(<NotificationEventManagement />);
  const action = enabled ? "Disable" : "Enable";
  fireEvent.click(await screen.findByRole("button", { name: `${action} Service degraded` }));
  expect(mockFetch.mock.calls.some((call) => call[1]?.method === "PATCH")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: `${action} Service degraded` }));
  mockFetch.mockResolvedValue(reply([{ id: "platform", label: "Platform", events: [updated] }]));
  fireEvent.click(screen.getByRole("button", { name: enabled ? "Confirm disable" : "Enable event" }));
  await screen.findByRole("button", { name: `${enabled ? "Enable" : "Disable"} Service degraded` });
  const body = JSON.parse(mockFetch.mock.calls.find((call) => call[1]?.method === "PATCH")[1].body);
  expect(body).toMatchObject({ revision: 3, enabled: !enabled, audience: "organization_admins" });
  expect(body).not.toHaveProperty("locked");
  expect(body).not.toHaveProperty("deliveryGeneration");
});
it("keeps required workflow events locked on the row", async () => {
  mockFetch.mockResolvedValue(reply([{ id: "platform", label: "Platform", events: [{ ...event, label: "Approval requested", eventType: "approval.requested", locked: true }] }]));
  render(<NotificationEventManagement />);
  expect(await screen.findByRole("button", { name: "Approval requested is required" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Disable Approval requested" })).not.toBeInTheDocument();
});
it("retains confirmation and reports a rejected quick enablement change", async () => {
  render(<NotificationEventManagement />);
  fireEvent.click(await screen.findByRole("button", { name: "Disable Service degraded" }));
  mockFetch.mockResolvedValue({ ok: false, json: async () => ({ success: false, error: "Reload this event before editing" }) });
  fireEvent.click(screen.getByRole("button", { name: "Confirm disable" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Reload this event before editing");
  expect(screen.getByRole("dialog")).toBeInTheDocument();
});
