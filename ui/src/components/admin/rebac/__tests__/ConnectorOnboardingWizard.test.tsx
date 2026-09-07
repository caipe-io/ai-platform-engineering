import { fireEvent, render, screen } from "@testing-library/react";

import {
  ConnectorOnboardingWizard,
  type ConnectorOnboardingRow,
} from "../ConnectorOnboardingWizard";

function makeRow(overrides: Partial<ConnectorOnboardingRow>): ConnectorOnboardingRow {
  const name = overrides.name ?? "Space";
  return {
    id: overrides.id ?? name,
    name,
    secondary: overrides.secondary ?? "group",
    selected: overrides.selected ?? false,
    teamSlug: overrides.teamSlug ?? "",
    agentId: overrides.agentId ?? "",
    isExisting: overrides.isExisting ?? false,
    teamRequired: overrides.teamRequired,
    selectable: overrides.selectable,
    importLabel: `Import ${name}`,
    teamLabel: `Team for ${name}`,
    agentLabel: `Dynamic Agent for ${name}`,
    pendingApproval: overrides.pendingApproval,
  };
}

function renderWizard(
  rows: ConnectorOnboardingRow[],
  onApply = jest.fn(),
  searchValue?: string,
) {
  render(
    <ConnectorOnboardingWizard
      itemSingular="space"
      itemPlural="spaces"
      discoveredLabel="space"
      findLabel="Find spaces"
      refreshLabel="Refresh"
      loadingLabel="Loading…"
      emptyLabel="No spaces"
      description="desc"
      discoveryStatusText="status"
      discoveredCount={rows.length}
      configuredCount={rows.filter((r) => r.isExisting).length}
      newCount={rows.length}
      selectedCount={rows.filter((r) => r.selected && r.teamSlug && r.agentId).length}
      rows={rows}
      teams={[{ value: "team-a", label: "Team A" }]}
      agents={[{ value: "agent-a", label: "Agent A" }]}
      error={null}
      disabled={false}
      loading={false}
      discovering={false}
      onDiscover={jest.fn()}
      onSelectAll={jest.fn()}
      onClearSelection={jest.fn()}
      onRowChange={jest.fn()}
      onApply={onApply}
      searchValue={searchValue}
    />,
  );
  return onApply;
}

it("enables Submit for the ready rows and skips blocked rows when both are selected", () => {
  const onApply = renderWizard([
    makeRow({ id: "ready", name: "Ready Space", selected: true, teamSlug: "team-a", agentId: "agent-a" }),
    makeRow({ id: "blocked", name: "Blocked Space", selected: true }),
  ]);

  // Only the one ready row is counted in the button label (not 2 selected).
  const applyButton = screen.getByRole("button", { name: "Submit 1 space" });
  expect(applyButton).toBeEnabled();

  // The admin is told the blocked row will be skipped rather than being blocked.
  expect(screen.getByText("1 space will be skipped (need a team or Dynamic Agent).")).toBeInTheDocument();
  expect(
    screen.queryByText(/need a team or Dynamic Agent before setup/i),
  ).not.toBeInTheDocument();

  fireEvent.click(applyButton);
  expect(onApply).toHaveBeenCalledTimes(1);
});

it("disables Submit only when every selected row is blocked", () => {
  renderWizard([
    makeRow({ id: "b1", name: "Blocked One", selected: true }),
    makeRow({ id: "b2", name: "Blocked Two", selected: true }),
  ]);

  expect(screen.getByRole("button", { name: "Submit 0 spaces" })).toBeDisabled();
  expect(
    screen.getByText("2 spaces need both a Team and Dynamic Agent."),
  ).toBeInTheDocument();
});

it("disables Submit when nothing is selected", () => {
  renderWizard([
    makeRow({ id: "ready", name: "Ready Space", selected: false, teamSlug: "team-a", agentId: "agent-a" }),
  ]);

  expect(screen.getByRole("button", { name: "Submit 0 spaces" })).toBeDisabled();
  expect(screen.getByText("Select at least one space to set up.")).toBeInTheDocument();
});

it("shows non-team direct rooms as personal DMs instead of team-assigned rows", () => {
  renderWizard([
    makeRow({
      id: "direct",
      name: "Sri Aradhyula",
      secondary: "direct-room · direct",
      selected: true,
      teamSlug: "team-a",
      agentId: "agent-a",
      teamRequired: false,
      selectable: false,
    }),
  ]);

  const checkbox = screen.getByRole("checkbox", { name: "Import Sri Aradhyula" });
  expect(checkbox).toBeDisabled();
  expect(checkbox).not.toBeChecked();
  expect(screen.queryByLabelText("Team for Sri Aradhyula")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Dynamic Agent for Sri Aradhyula")).not.toBeInTheDocument();
  expect(screen.getAllByText("Personal DM")).toHaveLength(2);
  expect(screen.getByText("Direct user routing")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Submit 0 spaces" })).toBeDisabled();
});

it("matches a row by ID when the name does not contain the search string", () => {
  renderWizard(
    [
      makeRow({ id: "C0912ABCDE", name: "general", secondary: "channel" }),
      makeRow({ id: "C0100OTHER", name: "random", secondary: "channel" }),
    ],
    jest.fn(),
    "c0912",
  );

  expect(screen.getByText("general")).toBeInTheDocument();
  expect(screen.queryByText("random")).not.toBeInTheDocument();
});

it("excludes a row whose name, id, and secondary all fail to match the search", () => {
  renderWizard(
    [makeRow({ id: "C0912ABCDE", name: "general", secondary: "channel" })],
    jest.fn(),
    "nonexistent",
  );

  expect(screen.queryByText("general")).not.toBeInTheDocument();
  expect(screen.getByText('No spaces match "nonexistent".')).toBeInTheDocument();
});

it("shows the requester's persisted Slack onboarding choices after refresh", () => {
  renderWizard([
    makeRow({
      id: "channel-primary",
      name: "Primary Channel",
      selected: true,
      teamSlug: "team-a",
      agentId: "agent-a",
      pendingApproval: {
        requestId: "request-primary",
        status: "pending",
        requester: { subject: "user-primary", name: "Example User" },
        requesterIsViewer: true,
        teamSlug: "team-a",
        agentId: "agent-a",
        approverTeamSlugs: ["team-a"],
        approverUserSubjects: [],
      },
    }),
  ]);

  expect(screen.getByText("Awaiting approval")).toBeInTheDocument();
  expect(screen.getByText(/Submitted by you; awaiting approval from Team A/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Submit 0 spaces" })).toBeDisabled();
});

it("allows the requester to resubmit changed choices or clear both to withdraw", () => {
  const pendingApproval = {
    requestId: "request-primary",
    status: "pending" as const,
    requester: { subject: "user-primary", name: "Example User" },
    requesterIsViewer: true,
    teamSlug: "team-a",
    agentId: "agent-original",
    approverTeamSlugs: ["team-a"],
    approverUserSubjects: [],
  };
  const { unmount } = render(
    <ConnectorOnboardingWizard
      itemSingular="space"
      itemPlural="spaces"
      discoveredLabel="space"
      findLabel="Find spaces"
      refreshLabel="Refresh"
      loadingLabel="Loading…"
      emptyLabel="No spaces"
      description="desc"
      discoveryStatusText="status"
      discoveredCount={1}
      configuredCount={0}
      newCount={1}
      selectedCount={1}
      rows={[makeRow({
        selected: true,
        teamSlug: "team-a",
        agentId: "agent-a",
        pendingApproval,
      })]}
      teams={[{ value: "team-a", label: "Team A" }]}
      agents={[{ value: "agent-a", label: "Agent A" }]}
      error={null}
      disabled={false}
      loading={false}
      discovering={false}
      onDiscover={jest.fn()}
      onSelectAll={jest.fn()}
      onClearSelection={jest.fn()}
      onRowChange={jest.fn()}
      onApply={jest.fn()}
    />,
  );
  expect(screen.getByText("Ready to resubmit")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Submit 1 space" })).toBeEnabled();
  unmount();

  renderWizard([
    makeRow({
      selected: true,
      teamSlug: "",
      agentId: "",
      pendingApproval,
    }),
  ]);
  expect(screen.getByText("Ready to withdraw")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Withdraw 1 request" })).toBeEnabled();
});

it("shows another user's pending request without allowing edits", () => {
  renderWizard([
    makeRow({
      selected: false,
      selectable: false,
      teamSlug: "team-a",
      agentId: "agent-a",
      pendingApproval: {
        requestId: "request-primary",
        status: "pending",
        requester: { subject: "user-secondary", name: "Another User" },
        requesterIsViewer: false,
        teamSlug: "team-a",
        agentId: "agent-a",
        approverTeamSlugs: ["team-a"],
        approverUserSubjects: [],
      },
    }),
  ]);

  expect(screen.getByText(/Submitted by Another User; awaiting approval from Team A/)).toBeInTheDocument();
  expect(screen.getByLabelText("Team for Space")).toBeDisabled();
  expect(screen.getByLabelText("Dynamic Agent for Space")).toBeDisabled();
});
