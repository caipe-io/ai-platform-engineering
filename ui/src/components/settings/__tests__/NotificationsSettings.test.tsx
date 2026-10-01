/** @jest-environment jsdom */

import userEvent from "@testing-library/user-event";
import { render,screen,waitFor } from "@testing-library/react";

let mockIsAdmin = true;
jest.mock("@/hooks/use-admin-role",() => ({
  useAdminRole: () => ({ isAdmin: mockIsAdmin }),
}));

jest.mock("@/components/settings/ReleaseNotesPreview",() => ({
  ReleaseNotesPreview: () => <div>Release notes preview</div>,
}));

import { NotificationsSettings } from "@/components/settings/sections/NotificationsSettings";

beforeEach(() => {
  jest.clearAllMocks();
  mockIsAdmin = true;
});

it("hides platform health notification controls from non-admin users",async () => {
  mockIsAdmin = false;
  jest.spyOn(global,"fetch").mockResolvedValue({
    ok: true,
    json: async () => ({
      success: true,
      data: {
        preferences: { releaseNotesNotificationsEnabled: true },
        notifications: { platform_health: true },
      },
    }),
  } as Response);

  render(<NotificationsSettings />);

  await screen.findByRole("switch",{ name: "Notify me about new releases" });
  expect(screen.queryByText("Platform health")).not.toBeInTheDocument();
  expect(screen.queryByRole("switch",{ name: "Notify me about platform health" })).not.toBeInTheDocument();
});

it("loads and saves the personal platform health notification preference",async () => {
  const refreshListener = jest.fn();
  window.addEventListener("in-app-notifications:refresh",refreshListener);
  const fetchMock = jest.spyOn(global,"fetch")
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          preferences: { releaseNotesNotificationsEnabled: true },
          notifications: { platform_health: false },
        },
      }),
    } as Response)
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    } as Response);

  render(<NotificationsSettings />);

  const toggle = await screen.findByRole("switch",{
    name: "Notify me about platform health",
  });
  expect(toggle).toHaveAttribute("aria-checked","false");

  await userEvent.click(toggle);

  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    "/api/settings/notifications",
    expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ platform_health: true }),
    }),
  ));
  await waitFor(() => expect(refreshListener).toHaveBeenCalled());
  window.removeEventListener("in-app-notifications:refresh",refreshListener);
});

it("expands and collapses notification sections individually or together",async () => {
  jest.spyOn(global,"fetch").mockResolvedValue({
    ok: true,
    json: async () => ({
      success: true,
      data: {
        preferences: { releaseNotesNotificationsEnabled: true },
        notifications: { platform_health: true },
      },
    }),
  } as Response);

  render(<NotificationsSettings />);
  await screen.findByRole("switch",{ name: "Notify me about platform health" });

  await userEvent.click(screen.getByRole("button",{ name: "Collapse Release notes" }));
  expect(screen.queryByText("Release notes preview")).not.toBeInTheDocument();
  expect(screen.getByRole("switch",{ name: "Notify me about platform health" })).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button",{ name: "Collapse all" }));
  expect(screen.queryByRole("switch",{ name: "Notify me about platform health" })).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button",{ name: "Expand all" }));
  expect(screen.getByText("Release notes preview")).toBeInTheDocument();
  expect(screen.getByRole("switch",{ name: "Notify me about platform health" })).toBeInTheDocument();
});
