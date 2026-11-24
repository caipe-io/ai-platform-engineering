/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockPush = jest.fn();
const mockDeferred = jest.fn();
const mockRequestNavigation = jest.fn();
let mockHasUnsavedChanges = false;

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

jest.mock("@/store/unsaved-changes-store", () => {
  const state = () => ({
    hasUnsavedChanges: mockHasUnsavedChanges,
    requestNavigation: mockRequestNavigation,
    requestDeferredAction: mockDeferred,
  });
  return { useUnsavedChangesStore: Object.assign(state, { getState: state }) };
});

import { NotificationBell } from "../NotificationBell";

afterEach(() => {
  mockHasUnsavedChanges = false;
  mockRequestNavigation.mockClear();
});

it("shows a friendly empty state",async () => {
  global.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => ({
      notifications: [],
      unread_count: 0,
      pagination: { page: 1,page_size: 10,total: 0,total_pages: 1 },
    }),
  })) as jest.Mock;

  render(<NotificationBell enabled />);
  fireEvent.click(await screen.findByRole("button",{ name: "Notifications" }));

  expect(await screen.findByText("You’re all caught up ✅")).toBeInTheDocument();
  expect(screen.getByText("No notifications yet... but why not try to change that?"))
    .toBeInTheDocument();
});

it("shows unread approval outcomes and marks one read when opened", async () => {
  const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/notifications?")) {
      return {
        ok: true,
        json: async () => ({
          notifications: [{
            id: "notification-primary",
            title: "Request rejected",
            message: "Slack: #primary was rejected by Review Admin.",
            href: "/admin?cat=security&tab=approvals&view=history",
            severity: "error",
            created_at: "2026-01-01T00:00:00.000Z",
            read: false,
          }],
          unread_count: 1,
          pagination: { page: 1, page_size: 10, total: 1, total_pages: 1 },
        }),
      } as Response;
    }
    return { ok: true, json: async () => ({ read: true }) } as Response;
  });
  global.fetch = fetchMock;

  render(<NotificationBell enabled />);

  const trigger = await screen.findByRole("button", {
    name: "1 unread notifications",
  });
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByText("Request rejected"));

  expect(mockPush).toHaveBeenCalledWith(
    "/admin/security/approvals?view=history",
  );
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    "/api/notifications/notification-primary",
    expect.objectContaining({ method: "PATCH" }),
  ));
});

it("labels global platform incidents and their resolved lifecycle",async () => {
  global.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => ({
      notifications: [{
        id: "platform-primary",
        title: "Chat Runtime recovered",
        message: "A platform health audit confirmed recovery.",
        href: "/admin/operations/health",
        severity: "success",
        category: "platform_health",
        source_label: "Platform",
        lifecycle_status: "resolved",
        created_at: "2026-08-20T10:00:00.000Z",
        read: true,
      }],
      unread_count: 0,
      pagination: { page: 1,page_size: 10,total: 1,total_pages: 1 },
    }),
  })) as jest.Mock;

  render(<NotificationBell enabled />);
  fireEvent.click(await screen.findByRole("button",{ name: "Notifications" }));

  expect(await screen.findByText("Platform")).toBeInTheDocument();
  expect(screen.getByText("Resolved")).toBeInTheDocument();
});


it("uses document navigation for callback markers through the existing unsaved-edit guard", async () => {
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({
    notifications: [{ id: "notification-example", title: "Example update", message: "Example changed", href: "/notifications/open/" + "a".repeat(64), severity: "info", created_at: "2026-01-01T00:00:00Z", read: true }],
    unread_count: 0, pagination: { page: 1, page_size: 10, total: 1, total_pages: 1 },
  }) })) as jest.Mock;
  render(<NotificationBell enabled />);
  fireEvent.click(await screen.findByRole("button", { name: "Notifications" }));
  fireEvent.click(await screen.findByText("Example update"));
  expect(mockDeferred).toHaveBeenCalledWith(expect.any(Function));
});

it("guards same-tab navigation to settings from the subscriptions panel", async () => {
  mockHasUnsavedChanges = true;
  global.fetch = jest.fn(async (url) => ({
    ok: true,
    json: async () => String(url).startsWith("/api/notifications/subscriptions")
      ? { success: true, data: { sources: [] } }
      : { notifications: [], unread_count: 0, pagination: { page: 1, page_size: 10, total: 0, total_pages: 1 } },
  })) as jest.Mock;
  render(<NotificationBell enabled />);

  fireEvent.click(await screen.findByRole("button", { name: "Notifications" }));
  fireEvent.click(screen.getByRole("button", { name: "Subscriptions" }));
  const link = screen.getByRole("link", { name: "Manage notification settings" });
  fireEvent.click(link, { ctrlKey: true });
  expect(mockRequestNavigation).not.toHaveBeenCalled();
  expect(fireEvent.click(link)).toBe(false);
  expect(mockRequestNavigation).toHaveBeenCalledWith("/settings/notifications");
});
