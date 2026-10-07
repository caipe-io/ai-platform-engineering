import { render, screen } from "@testing-library/react";

import { TeamDetailsDialog } from "../TeamDetailsDialog";
import type { Team } from "@/types/teams";

const fetchMock = jest.fn();

const baseTeam: Team = {
  _id: "team-1",
  slug: "platform",
  name: "Platform Engineering",
  description: "Handles platform infrastructure and tooling.",
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
  ],
};

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as Response;
}

function membersPayload(): Response {
  return jsonResponse({
    success: true,
    data: {
      members: [
        {
          identity_key: "owner@example.com",
          user_email: "owner@example.com",
          role: "owner",
          source_types: ["manual"],
          idp_managed: false,
          added_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      total: 1,
      page: 1,
      page_size: 25,
      has_more: false,
    },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => membersPayload());
  global.fetch = fetchMock as unknown as typeof fetch;
});

// Regression guard: the description used to sit in a plain flex
// justify-between row, so a long, wrapping value defaulted to left-aligned
// text instead of aligning with the other right-hand values in this list.
it("right-aligns the description value in the read-only details view", () => {
  render(
    <TeamDetailsDialog
      team={baseTeam}
      mode="details"
      open
      onOpenChange={jest.fn()}
      onTeamUpdated={jest.fn()}
    />,
  );

  const label = screen.getByText("Description");
  const value = label.nextElementSibling as HTMLElement;
  expect(value.textContent).toBe(baseTeam.description);
  expect(value.className).toContain("text-right");
});

// Regression guard: the role <Select> carries a `w-full` base class, and
// because it sat directly in the same flex row as the search input (also
// flexible), it fought the search input for space and squeezed it down to a
// sliver. The select must now be constrained by a fixed-width, non-shrinking
// wrapper so the search input gets the rest of the row.
it("constrains the member role selector to a fixed width so the search input can expand", async () => {
  render(
    <TeamDetailsDialog
      team={baseTeam}
      mode="members"
      open
      onOpenChange={jest.fn()}
      onTeamUpdated={jest.fn()}
    />,
  );

  const roleSelect = await screen.findByRole("combobox");
  const wrapper = roleSelect.parentElement;
  expect(wrapper?.className).toContain("w-28");
  expect(wrapper?.className).toContain("shrink-0");

  const searchInput = screen.getByPlaceholderText(/Search by name or email/i);
  expect(searchInput.parentElement?.className).toContain("flex-1");
});
