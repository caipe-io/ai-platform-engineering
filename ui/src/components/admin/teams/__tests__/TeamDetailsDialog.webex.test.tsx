import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { TeamDetailsDialog } from "../TeamDetailsDialog";
import type { Team } from "@/types/teams";

const fetchMock = jest.fn();

const team: Team = {
  _id: "team-1",
  slug: "platform",
  name: "Platform Engineering",
  owner_id: "owner@example.com",
  created_at: new Date("2026-01-01"),
  updated_at: new Date("2026-01-01"),
  members: [],
  can_manage: true,
};

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/admin/teams/team-1/slack-channels" && (!init?.method || init.method === "GET")) {
      return jsonResponse({
        success: true,
        data: {
          team_id: "team-1",
          channels: [{ slack_channel_id: "C0B4GLC5EFQ", channel_name: "new-slack-channel" }],
        },
      });
    }
    if (url === "/api/admin/teams/team-1/webex-spaces" && (!init?.method || init.method === "GET")) {
      return jsonResponse({
        success: true,
        data: {
          team_id: "team-1",
          spaces: [{ webex_space_id: "space-1", space_name: "Alerts" }],
        },
      });
    }
    if (url === "/api/admin/teams/team-1/webex-spaces" && init?.method === "PUT") {
      return jsonResponse({
        success: true,
        data: {
          team_id: "team-1",
          spaces: [],
          removed_space_ids: ["space-1"],
        },
      });
    }
    return jsonResponse({ success: true, data: {} });
  });
});

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as Response;
}

it("lists the team's assigned Slack channels without a discovery panel", async () => {
  render(
    <TeamDetailsDialog
      team={team}
      mode="channels"
      open
      onOpenChange={jest.fn()}
      onTeamUpdated={jest.fn()}
    />
  );

  // Assigned channels render...
  expect(await screen.findByText("new-slack-channel")).toBeInTheDocument();
  expect(screen.getByText("C0B4GLC5EFQ")).toBeInTheDocument();

  // ...and the discovery/manual-add affordances are gone (assignment moved
  // to Integrations -> Slack).
  expect(screen.queryByPlaceholderText("Search bot-member channels...")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Refresh bot channels" })).not.toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalledWith(
    expect.stringContaining("/api/admin/slack/available-channels")
  );
});

it("removes an assigned Webex space and saves from the team dialog", async () => {
  render(
    <TeamDetailsDialog
      team={team}
      mode="webex"
      open
      onOpenChange={jest.fn()}
      onTeamUpdated={jest.fn()}
    />
  );

  expect(await screen.findByText("Alerts")).toBeInTheDocument();

  // No discovery panel; assignment lives under Integrations -> Webex.
  expect(screen.queryByPlaceholderText("Y2lzY29zcGFyazov...")).not.toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalledWith(
    expect.stringContaining("/api/admin/webex/available-spaces")
  );

  fireEvent.click(screen.getByRole("button", { name: /Remove from team/i }));
  fireEvent.click(screen.getByRole("button", { name: "Save spaces" }));

  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/teams/team-1/webex-spaces",
      expect.objectContaining({
        method: "PUT",
        body: expect.stringContaining('"spaces":[]'),
      })
    )
  );
});

it("shows Webex assignments without edit controls in read-only mode", async () => {
  render(
    <TeamDetailsDialog
      team={{ ...team, can_manage: false }}
      mode="webex"
      open
      onOpenChange={jest.fn()}
      onTeamUpdated={jest.fn()}
    />
  );

  expect(await screen.findByText("Alerts")).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /Remove from team/i }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Save spaces" }),
  ).not.toBeInTheDocument();
});
