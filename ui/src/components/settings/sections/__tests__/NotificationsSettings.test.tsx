/**
 * @jest-environment jsdom
 */

import { act,fireEvent,render,screen,waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { NotificationsSettings } from "../NotificationsSettings";
import { PlatformAnnouncementsSettings } from "../PlatformAnnouncementsSettings";
import * as completionAlerts from "@/lib/agent-completion-notifications";

jest.mock("@/lib/agent-completion-notifications", () => ({
  ...jest.requireActual("@/lib/agent-completion-notifications"),
  playCompletionChime: jest.fn(),
}));

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

  it("separates tabs, preserves a quiet-hours draft, and loads history only on demand", async () => {
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/notifications/subscriptions") return jsonResponse({ success: true, data: {
        global: { channels: { in_app: true }, quietHours: { enabled: false, start: "22:00", end: "07:00", timeZone: "UTC" } },
        webPushPublicKey: null,
        sources: [
          { id: "platform", label: "CAIPE", subscription: {}, events: [] },
          { id: "app:example", label: "Example app", subscription: { enabled: true }, events: [] },
        ],
      } });
      if (url === "/api/notifications/channels") return jsonResponse({ success: true, data: { in_app: true } });
      if (url === "/api/notifications/deliveries") return jsonResponse({ success: true, data: { deliveries: [
        { id: "example-delivery", sourceLabel: "Example app", eventType: "report.ready", channel: "in_app", status: "delivered", attempts: 1 },
      ] } });
      return jsonResponse({ success: true, data: {} });
    });
    global.fetch = fetchMock;
    render(<NotificationsSettings />);
    const start = await screen.findByLabelText("Quiet hours start");
    fireEvent.change(start, { target: { value: "21:30" } });
    expect(screen.queryByRole("switch", { name: "Subscribe to Example app" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refresh delivery status" })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith("/api/notifications/deliveries", expect.anything());

    await userEvent.click(screen.getByRole("tab", { name: "Apps" }));
    expect(screen.getByRole("switch", { name: "Subscribe to Example app" })).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Subscribe to CAIPE" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Quiet hours start")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: "Platform" }));
    expect(screen.getByRole("switch", { name: "Subscribe to CAIPE" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Notify me about new releases" })).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Subscribe to Example app" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: "Notification delivery" }));
    expect(screen.getByLabelText("Quiet hours start")).toHaveValue("21:30");
    await userEvent.click(screen.getByRole("tab", { name: "Delivery status" }));
    expect(await screen.findByText(/report.ready/)).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Enable In-app inbox" })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/notifications/subscriptions")).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/notifications/deliveries")).toHaveLength(1);
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

    const chime = await screen.findByRole("switch",{ name: "Enable chime" });
    expect(chime).toHaveAttribute("aria-checked", "false");
    expect(screen.getAllByRole("switch", { name: "Enable chime" })).toHaveLength(1);
    fireEvent.click(chime);

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

  it.each([true, false, "error"])("tests only chime audio and reports browser acceptance %s", async (played) => {
    const play = jest.mocked(completionAlerts.playCompletionChime);
    if (played === "error") play.mockRejectedValue(new Error("Audio unavailable"));
    else play.mockResolvedValue(played as boolean);
    global.fetch = jest.fn(async () => jsonResponse({ success: true, data: {
      notifications: { agent_completion_chime_enabled: true },
    } }));
    render(<NotificationsSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Test chime" }));
    expect(await screen.findByText(played === true ? "Chime played." : /browser could not play the chime/)).toBeInTheDocument();
    expect(play).toHaveBeenCalledTimes(1);
    expect(MockNotification.requestPermission).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalledWith("/api/notifications/test", expect.anything());
  });

  it("loads an opted-out personal preference",async () => {
    global.fetch = jest.fn(async () => jsonResponse({
      success: true,
      data: { preferences: { releaseNotesNotificationsEnabled: false } },
    }));

    render(<NotificationsSettings />);
    await userEvent.click(await screen.findByRole("tab", { name: "Platform" }));

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
    await userEvent.click(screen.getByRole("tab", { name: "Platform" }));
    expect(screen.getByRole("switch",{ name: "Notify me about new releases" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button",{ name: "Collapse all" }));
    expect(screen.queryByRole("switch",{ name: "Notify me about new releases" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button",{ name: "Expand all" }));
    expect(screen.getByRole("switch",{ name: "Notify me about new releases" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Notification delivery" }));
    expect(screen.queryByRole("switch",{ name: "Browser notifications for agent completions" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button",{ name: "Expand all" }));
    expect(screen.getByRole("switch",{
      name: "Browser notifications for agent completions",
    })).toBeInTheDocument();
    expect(screen.queryByRole("switch",{ name: "Notify me about new releases" })).not.toBeInTheDocument();
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
    await userEvent.click(await screen.findByRole("tab", { name: "Platform" }));

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
    await userEvent.click(await screen.findByRole("tab", { name: "Platform" }));

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

  it("auto-saves only the platform flag, not the editable compare draft",async () => {
    const fetchMock = jest.fn(async (_input: RequestInfo | URL,init?: RequestInit) => {
      if (init?.method === "PATCH") return jsonResponse({ success: true,data: {} });
      return jsonResponse({
        success: true,
        data: { release_notes: { enabled: true }, release_notes_allowed_repositories: ["https://github.com/example/repository"] },
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
          body: JSON.stringify({
            release_notes: {
              enabled: false,
            },
          }),
        }),
      );
    });
  });

  it("saves the optional GitHub commit range",async () => {
    const fetchMock = jest.fn(async (_input: RequestInfo | URL,init?: RequestInit) => {
      if (init?.method === "PATCH") return jsonResponse({ success: true,data: {} });
      return jsonResponse({
        success: true,
        data: { release_notes: { enabled: true }, release_notes_allowed_repositories: ["https://github.com/example/repository"] },
      });
    });
    global.fetch = fetchMock;
    render(<PlatformAnnouncementsSettings />);

    fireEvent.change(await screen.findByLabelText("Repository URL"), {
      target: { value: "https://github.com/example/repository" },
    });
    fireEvent.change(screen.getByLabelText("Previous upgraded commit"), {
      target: { value: "1111111" },
    });
    fireEvent.change(screen.getByLabelText("Latest commit"), {
      target: { value: "2222222" },
    });
    fireEvent.click(screen.getByRole("button",{ name: "Save release notes configuration" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/platform-config",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({
            release_notes: {
              repository_url: "https://github.com/example/repository",
              previous_commit: "1111111",
              latest_commit: "2222222",
            },
          }),
        }),
      );
    });
  });

  it("keeps edits made during a pending save dirty and submits them on the next save", async () => {
    let finish!: (response: Response) => void;
    const writes: unknown[] = [];
    global.fetch = jest.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "PATCH") return jsonResponse({ success: true, data: { release_notes: { enabled: true }, release_notes_allowed_repositories: ["https://github.com/example/repository"] } });
      writes.push(JSON.parse(init.body as string));
      if (writes.length === 1) return new Promise<Response>((resolve) => { finish = resolve; });
      return jsonResponse({ success: true });
    });
    render(<PlatformAnnouncementsSettings />);
    fireEvent.change(await screen.findByLabelText("Repository URL"), { target: { value: "https://github.com/example/repository" } });
    fireEvent.change(screen.getByLabelText("Previous upgraded commit"), { target: { value: "1111111" } });
    fireEvent.change(screen.getByLabelText("Latest commit"), { target: { value: "2222222" } });
    const save = screen.getByRole("button", { name: "Save release notes configuration" });
    fireEvent.click(save);
    fireEvent.change(screen.getByLabelText("Latest commit"), { target: { value: "3333333" } });
    await act(async () => { finish(jsonResponse({ success: true })); });
    expect(writes[0]).toMatchObject({ release_notes: { latest_commit: "2222222" } });
    expect(save).toBeEnabled();
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    fireEvent.click(save);
    await waitFor(() => expect(writes[1]).toMatchObject({ release_notes: { latest_commit: "3333333" } }));
  });

  it("disables the platform control in read-only simulation",async () => {
    global.fetch = jest.fn(async () => jsonResponse({
      success: true,
      data: { release_notes: { enabled: true }, release_notes_allowed_repositories: ["https://github.com/example/repository"] },
    }));

    render(<PlatformAnnouncementsSettings readOnly />);

    expect(await screen.findByRole("switch",{
      name: "Enable release announcements for the platform",
    })).toBeDisabled();
  });

  it("does not offer arbitrary repositories and lets admins replace a stale choice", async () => {
    global.fetch = jest.fn(async () => jsonResponse({ success: true, data: {
      release_notes: { repository_url: "https://github.com/example/removed", previous_commit: "primary", latest_commit: "secondary" },
      release_notes_allowed_repositories: ["https://github.com/example/repository"],
    } }));
    render(<PlatformAnnouncementsSettings />);
    const repository = await screen.findByRole("combobox", { name: "Repository URL" });
    expect(screen.queryByRole("textbox", { name: "Repository URL" })).not.toBeInTheDocument();
    expect(repository).toHaveValue("https://github.com/example/removed");
    expect(screen.getByRole("option", { name: /not approved/ })).toBeDisabled();
    fireEvent.change(repository, { target: { value: "https://github.com/example/repository" } });
    fireEvent.click(screen.getByRole("button", { name: "Save release notes configuration" }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith("/api/admin/platform-config", expect.objectContaining({
      method: "PATCH", body: JSON.stringify({ release_notes: {
        repository_url: "https://github.com/example/repository", previous_commit: "primary", latest_commit: "secondary",
      } }),
    })));
  });

  it("marks padded refs saved while still trimming the submitted values", async () => {
    const writes: unknown[] = [];
    global.fetch = jest.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") writes.push(JSON.parse(init.body as string));
      return jsonResponse({ success: true, data: {
        release_notes_allowed_repositories: ["https://github.com/example/repository"],
      } });
    });
    render(<PlatformAnnouncementsSettings />);
    fireEvent.change(await screen.findByLabelText("Repository URL"), { target: { value: "https://github.com/example/repository" } });
    fireEvent.change(screen.getByLabelText("Previous upgraded commit"), { target: { value: " primary " } });
    fireEvent.change(screen.getByLabelText("Latest commit"), { target: { value: " secondary " } });
    const save = screen.getByRole("button", { name: "Save release notes configuration" });
    fireEvent.click(save);
    await waitFor(() => expect(save).toBeDisabled());
    expect(writes[0]).toMatchObject({ release_notes: { previous_commit: "primary", latest_commit: "secondary" } });
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
    expect(await screen.findByText("Saved")).toBeInTheDocument();
  });

  it("rolls back and offers retry when the platform write fails",async () => {
    global.fetch = jest.fn(async (_input: RequestInfo | URL,init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return jsonResponse({ success: false,error: "Platform configuration unavailable" },false);
      }
      return jsonResponse({
        success: true,
        data: { release_notes: { enabled: true }, release_notes_allowed_repositories: ["https://github.com/example/repository"] },
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
        data: { release_notes: { enabled: true }, release_notes_allowed_repositories: ["https://github.com/example/repository"] },
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
