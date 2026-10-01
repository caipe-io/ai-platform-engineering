import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { TeamDetailsDialog } from "../TeamDetailsDialog";
import type { Team } from "@/types/teams";

const fetchMock = jest.fn();

const baseTeam: Team = {
  _id: "team-1",
  slug: "platform",
  name: "Platform Engineering",
  owner_id: "owner@example.com",
  created_at: new Date("2026-01-01"),
  updated_at: new Date("2026-01-01"),
  can_manage: true,
  members: [
    {
      user_id: "owner@example.com",
      role: "owner",
      added_at: new Date("2026-01-01"),
    },
    {
      user_id: "alice@example.com",
      role: "member",
      added_at: new Date("2026-01-02"),
    },
  ],
};

it("renders team details read-only when can_manage is false", () => {
  render(
    <TeamDetailsDialog
      team={{ ...baseTeam, can_manage: false, created_by: "bootstrap" }}
      mode="details"
      open
      onOpenChange={jest.fn()}
      onTeamUpdated={jest.fn()}
    />,
  );

  expect(screen.getByText("Created by")).toBeInTheDocument();
  expect(screen.getByText("System")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^Edit$/i })).not.toBeInTheDocument();
});

it("shows a read-only member roster without mutation controls", async () => {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (isMembersGet(url, init)) {
      return membersPayload([
        { user_email: "member@example.com", role: "member" },
      ]);
    }
    return jsonResponse({ success: true, data: { team: baseTeam } });
  });

  render(
    <TeamDetailsDialog
      team={{ ...baseTeam, can_manage: false }}
      mode="members"
      open
      onOpenChange={jest.fn()}
      onTeamUpdated={jest.fn()}
    />,
  );

  expect(await screen.findByText("member@example.com")).toBeInTheDocument();
  expect(screen.queryByPlaceholderText(/Search by name or email/i)).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /^Remove member@example.com$/i }),
  ).not.toBeInTheDocument();
});

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as Response;
}

// Build a paginated members payload mirroring GET /api/admin/teams/[id]/members.
function membersPayload(
  members: Array<{
    user_email: string;
    role: "owner" | "admin" | "member";
    source_types?: string[];
    idp_managed?: boolean;
  }>,
): Response {
  return jsonResponse({
    success: true,
    data: {
      members: members.map((m) => ({
        identity_key: m.user_email,
        user_email: m.user_email,
        role: m.role,
        source_types: m.source_types ?? ["manual"],
        idp_managed: m.idp_managed ?? false,
        added_at: "2026-01-02T00:00:00.000Z",
      })),
      total: members.length,
      page: 1,
      page_size: 25,
      has_more: false,
    },
  });
}

function isMembersGet(url: string, init?: RequestInit): boolean {
  return (
    url.startsWith("/api/admin/teams/team-1/members") &&
    (!init?.method || init.method === "GET")
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

it("renders members from the paginated members endpoint", async () => {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (isMembersGet(url, init)) {
      return membersPayload([
        { user_email: "alice@example.com", role: "member", source_types: ["active_directory"], idp_managed: true },
      ]);
    }
    // Team detail (OpenFGA diagnostic) — harmless empty.
    return jsonResponse({ success: true, data: { team: baseTeam } });
  });

  render(
    <TeamDetailsDialog
      team={baseTeam}
      mode="members"
      open
      onOpenChange={jest.fn()}
      onTeamUpdated={jest.fn()}
    />,
  );

  expect(await screen.findByText("alice@example.com")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^Members$/i })).toBeInTheDocument();
  expect(screen.queryByText("No members yet. Add members above.")).not.toBeInTheDocument();
});

it("calls onTeamMutated (not onTeamUpdated) when a member is added", async () => {
  const onTeamMutated = jest.fn();
  const onTeamUpdated = jest.fn();

  const updatedTeam: Team = { ...baseTeam };
  let added = false;
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/admin/teams/team-1/members" && init?.method === "POST") {
      added = true;
      return jsonResponse({ success: true, data: { team: updatedTeam } });
    }
    if (isMembersGet(url, init)) {
      // Bob shows up once the add has gone through.
      return membersPayload(
        added
          ? [
              { user_email: "alice@example.com", role: "member" },
              { user_email: "bob@example.com", role: "member" },
            ]
          : [{ user_email: "alice@example.com", role: "member" }],
      );
    }
    return jsonResponse({ success: true, data: { team: updatedTeam } });
  });

  render(
    <TeamDetailsDialog
      team={baseTeam}
      mode="members"
      open
      onOpenChange={jest.fn()}
      onTeamUpdated={onTeamUpdated}
      onTeamMutated={onTeamMutated}
    />,
  );

  const input = screen.getByPlaceholderText(/Search by name or email/i);
  fireEvent.change(input, { target: { value: "bob@example.com" } });

  const form = input.closest("form");
  if (!form) throw new Error("Add-member form not found");
  fireEvent.submit(form);

  await waitFor(() => {
    expect(onTeamMutated).toHaveBeenCalledTimes(1);
  });

  // The heavy parent-page reload callback must NOT fire when the
  // lightweight onTeamMutated path is wired in. This is the regression
  // guard for the "Add member refreshes the entire admin page" bug.
  expect(onTeamUpdated).not.toHaveBeenCalled();
  expect(onTeamMutated).toHaveBeenCalledWith(
    expect.objectContaining({ _id: "team-1" }),
  );

  // The modal stays mounted — the new member is now visible in the list
  // without any full-page reload having to happen.
  await waitFor(() => {
    expect(screen.getByText("bob@example.com")).toBeInTheDocument();
  });
});

it("shows an inline confirm row instead of window.confirm when removing a member", async () => {
  const onTeamMutated = jest.fn();
  const onTeamUpdated = jest.fn();

  const updatedTeam: Team = { ...baseTeam };
  let removed = false;
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (
      url.startsWith("/api/admin/teams/team-1/members") &&
      init?.method === "DELETE"
    ) {
      removed = true;
      return jsonResponse({ success: true, data: { team: updatedTeam } });
    }
    if (isMembersGet(url, init)) {
      // After the delete, the server no longer returns alice.
      return membersPayload(
        removed ? [] : [{ user_email: "alice@example.com", role: "member" }],
      );
    }
    return jsonResponse({ success: true, data: { team: updatedTeam } });
  });

  // Regression guard: the old flow called window.confirm() which is a
  // blocking modal at the browser level. We now use an inline confirm
  // row, so window.confirm must NEVER be invoked.
  const confirmSpy = jest.spyOn(window, "confirm").mockImplementation(() => {
    throw new Error(
      "window.confirm must not be called — use the inline confirm row",
    );
  });

  render(
    <TeamDetailsDialog
      team={baseTeam}
      mode="members"
      open
      onOpenChange={jest.fn()}
      onTeamUpdated={onTeamUpdated}
      onTeamMutated={onTeamMutated}
    />,
  );

  // First click: stages the inline confirm row, does NOT fire the API.
  const removeButton = await screen.findByRole("button", {
    name: /^Remove alice@example.com$/i,
  });
  fireEvent.click(removeButton);

  // The DELETE call must not have happened yet — only the trash icon
  // was clicked, the user still has to confirm.
  expect(
    fetchMock.mock.calls.filter(
      ([url, init]) =>
        typeof url === "string" &&
        url.startsWith("/api/admin/teams/team-1/members") &&
        (init as RequestInit | undefined)?.method === "DELETE",
    ),
  ).toHaveLength(0);

  // The inline confirm row should now be in the document.
  const confirmButton = await screen.findByRole("button", {
    name: /Confirm remove alice@example.com/i,
  });
  expect(confirmButton).toBeInTheDocument();
  expect(screen.getByText("Remove?")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: /Cancel removal/i }),
  ).toBeInTheDocument();

  // Second click: confirm.
  fireEvent.click(confirmButton);

  await waitFor(() => {
    expect(onTeamMutated).toHaveBeenCalledTimes(1);
  });
  expect(onTeamUpdated).not.toHaveBeenCalled();

  await waitFor(() => {
    expect(screen.queryByText("alice@example.com")).not.toBeInTheDocument();
  });

  expect(confirmSpy).not.toHaveBeenCalled();
  confirmSpy.mockRestore();
});

it("cancels the inline confirm row without calling the API", async () => {
  const onTeamMutated = jest.fn();
  const onTeamUpdated = jest.fn();

  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (isMembersGet(url, init)) {
      return membersPayload([
        { user_email: "alice@example.com", role: "member" },
      ]);
    }
    return jsonResponse({ success: true, data: {} });
  });

  render(
    <TeamDetailsDialog
      team={baseTeam}
      mode="members"
      open
      onOpenChange={jest.fn()}
      onTeamUpdated={onTeamUpdated}
      onTeamMutated={onTeamMutated}
    />,
  );

  fireEvent.click(
    await screen.findByRole("button", { name: /^Remove alice@example.com$/i }),
  );

  // Confirm row visible.
  expect(
    await screen.findByRole("button", {
      name: /Confirm remove alice@example.com/i,
    }),
  ).toBeInTheDocument();

  // Cancel.
  fireEvent.click(screen.getByRole("button", { name: /Cancel removal/i }));

  // Confirm row gone, original trash button returns, member still present.
  await waitFor(() => {
    expect(
      screen.queryByRole("button", {
        name: /Confirm remove alice@example.com/i,
      }),
    ).not.toBeInTheDocument();
  });
  expect(screen.getByText("alice@example.com")).toBeInTheDocument();

  // No DELETE call should have been issued.
  expect(
    fetchMock.mock.calls.filter(
      ([url, init]) =>
        typeof url === "string" &&
        url.startsWith("/api/admin/teams/team-1/members") &&
        (init as RequestInit | undefined)?.method === "DELETE",
    ),
  ).toHaveLength(0);

  expect(onTeamMutated).not.toHaveBeenCalled();
  expect(onTeamUpdated).not.toHaveBeenCalled();
});

it("falls back to onTeamUpdated when onTeamMutated is not provided (legacy behaviour)", async () => {
  const onTeamUpdated = jest.fn();

  const updatedTeam: Team = { ...baseTeam };
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/admin/teams/team-1/members" && init?.method === "POST") {
      return jsonResponse({ success: true, data: { team: updatedTeam } });
    }
    if (isMembersGet(url, init)) {
      return membersPayload([
        { user_email: "alice@example.com", role: "member" },
      ]);
    }
    return jsonResponse({ success: true, data: { team: updatedTeam } });
  });

  render(
    <TeamDetailsDialog
      team={baseTeam}
      mode="members"
      open
      onOpenChange={jest.fn()}
      onTeamUpdated={onTeamUpdated}
    />,
  );

  const input = screen.getByPlaceholderText(/Search by name or email/i);
  fireEvent.change(input, { target: { value: "charlie@example.com" } });
  const form = input.closest("form");
  if (!form) throw new Error("Add-member form not found");
  fireEvent.submit(form);

  await waitFor(() => {
    expect(onTeamUpdated).toHaveBeenCalledTimes(1);
  });
});
