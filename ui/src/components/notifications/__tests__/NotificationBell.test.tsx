/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockPush = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

jest.mock("@/store/unsaved-changes-store", () => ({
  useUnsavedChangesStore: () => ({
    hasUnsavedChanges: false,
    requestNavigation: jest.fn(),
  }),
}));

import { NotificationBell } from "../NotificationBell";

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
