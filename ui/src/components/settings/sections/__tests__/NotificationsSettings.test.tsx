/**
 * @jest-environment jsdom
 */

import { fireEvent,render,screen,waitFor } from "@testing-library/react";

import { NotificationsSettings } from "../NotificationsSettings";
import { PlatformAnnouncementsSettings } from "../PlatformAnnouncementsSettings";

jest.mock("@/hooks/use-admin-role",() => ({
  useAdminRole: () => ({ isAdmin: true }),
}));

jest.mock("@/components/settings/ReleaseNotesPreview",() => ({
  ReleaseNotesPreview: () => <button type="button">Show current release notes</button>,
}));

function jsonResponse(body: unknown,ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as Response;
}

class MockNotification {
  static permission: NotificationPermission = "default";
  static requestPermission = jest.fn<Promise<NotificationPermission>,[]>();

  close = jest.fn();
  onclick: (() => void) | null = null;

  constructor() {}
}

describe("NotificationsSettings",() => {
  beforeEach(() => {
    jest.clearAllMocks();
    MockNotification.permission = "default";
    MockNotification.requestPermission.mockResolvedValue("granted");
    Object.defineProperty(window,"Notification",{
      configurable: true,
      value: MockNotification,
    });
  });

  it("requests permission from the browser toggle and saves completion alerts",async () => {
    const fetchMock = jest.fn(async (_input: RequestInfo | URL,init?: RequestInit) => {
      if (init?.method === "PATCH") return jsonResponse({ success: true,data: {} });
      return jsonResponse({
        success: true,
        data: {
          notifications: {
            agent_completion_browser_enabled: false,
            agent_completion_chime_enabled: false,
          },
        },
      });
    });
    global.fetch = fetchMock;
    render(<NotificationsSettings />);

    fireEvent.click(await screen.findByRole("switch",{
      name: "Browser notifications for agent completions",
    }));

    await waitFor(() => {
      expect(MockNotification.requestPermission).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/settings/notifications",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ agent_completion_browser_enabled: true }),
        }),
      );
    });
  });

  it("does not save browser alerts when permission is denied",async () => {
    MockNotification.requestPermission.mockResolvedValue("denied");
    global.fetch = jest.fn(async () => jsonResponse({ success: true,data: {} }));
    render(<NotificationsSettings />);

    fireEvent.click(await screen.findByRole("switch",{
      name: "Browser notifications for agent completions",
    }));

    expect(await screen.findByText(/blocked by this browser/i)).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalledWith(
      "/api/settings/notifications",
      expect.objectContaining({ method: "PATCH" }),
    );
  });

  it("saves the optional completion chime independently",async () => {
    const fetchMock = jest.fn(async (_input: RequestInfo | URL,init?: RequestInit) => {
      if (init?.method === "PATCH") return jsonResponse({ success: true,data: {} });
      return jsonResponse({ success: true,data: {} });
    });
    global.fetch = fetchMock;
    render(<NotificationsSettings />);

    fireEvent.click(await screen.findByRole("switch",{ name: "Completion chime" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/settings/notifications",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ agent_completion_chime_enabled: true }),
        }),
      );
    });
  });

  it("loads an opted-out personal preference",async () => {
    global.fetch = jest.fn(async () => jsonResponse({
      success: true,
      data: { preferences: { releaseNotesNotificationsEnabled: false } },
    }));

    render(<NotificationsSettings />);

    expect(await screen.findByRole("switch",{ name: "Notify me about new releases" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("expands and collapses notification sections individually or together",async () => {
    global.fetch = jest.fn(async () => jsonResponse({ success: true,data: {} }));
    render(<NotificationsSettings />);

    await screen.findByRole("switch",{ name: "Browser notifications for agent completions" });
    fireEvent.click(screen.getByRole("button",{ name: "Collapse Agent completions" }));
    expect(screen.queryByRole("switch",{
      name: "Browser notifications for agent completions",
    })).not.toBeInTheDocument();
    expect(screen.getByRole("switch",{ name: "Notify me about new releases" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button",{ name: "Collapse all" }));
    expect(screen.queryByRole("switch",{ name: "Notify me about new releases" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button",{ name: "Expand all" }));
    expect(screen.getByRole("switch",{
      name: "Browser notifications for agent completions",
    })).toBeInTheDocument();
    expect(screen.getByRole("switch",{ name: "Notify me about new releases" })).toBeInTheDocument();
  });

  it("auto-saves the personal preference without a Save button",async () => {
    const fetchMock = jest.fn(async (input: RequestInfo | URL,init?: RequestInit) => {
      if (init?.method === "PATCH") return jsonResponse({ success: true,data: {} });
      return jsonResponse({
        success: true,
        data: { preferences: { releaseNotesNotificationsEnabled: true } },
      });
    });
    global.fetch = fetchMock;
    render(<NotificationsSettings />);

    fireEvent.click(await screen.findByRole("switch",{ name: "Notify me about new releases" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/settings/preferences",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ releaseNotesNotificationsEnabled: false }),
        }),
      );
      expect(screen.getByText("Saved")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button",{ name: /^save$/i })).not.toBeInTheDocument();
  });

  it("restores the intended value while retrying a failed personal save",async () => {
    let writeCount = 0;
    const fetchMock = jest.fn(async (_input: RequestInfo | URL,init?: RequestInit) => {
      if (init?.method === "PATCH") {
        writeCount += 1;
        return writeCount === 1
          ? jsonResponse({ success: false,error: "Preference service unavailable" },false)
          : jsonResponse({ success: true,data: {} });
      }
      return jsonResponse({
        success: true,
        data: { preferences: { releaseNotesNotificationsEnabled: true } },
      });
    });
    global.fetch = fetchMock;
    render(<NotificationsSettings />);

    const toggle = await screen.findByRole("switch",{ name: "Notify me about new releases" });
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(toggle).toHaveAttribute("aria-checked","true");
      expect(screen.getByText("Preference service unavailable")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button",{ name: "Retry" }));

    await waitFor(() => {
      expect(toggle).toHaveAttribute("aria-checked","false");
      expect(screen.getByText("Saved")).toBeInTheDocument();
      expect(writeCount).toBe(2);
    });
  });
});

describe("PlatformAnnouncementsSettings",() => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("auto-saves only the platform release announcement flag",async () => {
    const fetchMock = jest.fn(async (_input: RequestInfo | URL,init?: RequestInit) => {
      if (init?.method === "PATCH") return jsonResponse({ success: true,data: {} });
      return jsonResponse({
        success: true,
        data: { release_notes: { enabled: true } },
      });
    });
    global.fetch = fetchMock;
    render(<PlatformAnnouncementsSettings />);

    fireEvent.click(await screen.findByRole("switch",{
      name: "Enable release announcements for the platform",
    }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/platform-config",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ release_notes: { enabled: false } }),
        }),
      );
    });
  });

  it("disables the platform control in read-only simulation",async () => {
    global.fetch = jest.fn(async () => jsonResponse({
      success: true,
      data: { release_notes: { enabled: true } },
    }));

    render(<PlatformAnnouncementsSettings readOnly />);

    expect(await screen.findByRole("switch",{
      name: "Enable release announcements for the platform",
    })).toBeDisabled();
  });

  it("rolls back and offers retry when the platform write fails",async () => {
    global.fetch = jest.fn(async (_input: RequestInfo | URL,init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return jsonResponse({ success: false,error: "Platform configuration unavailable" },false);
      }
      return jsonResponse({
        success: true,
        data: { release_notes: { enabled: true } },
      });
    });
    render(<PlatformAnnouncementsSettings />);

    const toggle = await screen.findByRole("switch",{
      name: "Enable release announcements for the platform",
    });
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(toggle).toHaveAttribute("aria-checked","true");
      expect(screen.getByText("Platform configuration unavailable")).toBeInTheDocument();
      expect(screen.getByRole("button",{ name: "Retry" })).toBeInTheDocument();
    });
  });

  it("restores the intended platform value when retry succeeds",async () => {
    let writeCount = 0;
    global.fetch = jest.fn(async (_input: RequestInfo | URL,init?: RequestInit) => {
      if (init?.method === "PATCH") {
        writeCount += 1;
        return writeCount === 1
          ? jsonResponse({ success: false,error: "Platform configuration unavailable" },false)
          : jsonResponse({ success: true,data: {} });
      }
      return jsonResponse({
        success: true,
        data: { release_notes: { enabled: true } },
      });
    });
    render(<PlatformAnnouncementsSettings />);

    const toggle = await screen.findByRole("switch",{
      name: "Enable release announcements for the platform",
    });
    fireEvent.click(toggle);
    await screen.findByText("Platform configuration unavailable");

    fireEvent.click(screen.getByRole("button",{ name: "Retry" }));

    await waitFor(() => {
      expect(toggle).toHaveAttribute("aria-checked","false");
      expect(screen.getByText("Saved")).toBeInTheDocument();
      expect(writeCount).toBe(2);
    });
  });
});
