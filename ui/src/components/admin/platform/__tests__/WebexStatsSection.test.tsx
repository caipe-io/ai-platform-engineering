import { render, screen } from "@testing-library/react";

import { WebexStatsSection } from "../WebexStatsSection";
import type { AdminWebexStats } from "@/types/admin-stats";

function makeWebexStats(overrides: Partial<AdminWebexStats> = {}): AdminWebexStats {
  return {
    total_interactions: 42,
    unique_users: 7,
    configured_spaces: 3,
    configured_spaces_daily: [
      { date: "2026-08-01", total: 1 },
      { date: "2026-08-02", total: 3 },
    ],
    daily: [
      { date: "2026-08-01", interactions: 20, unique_users: 4 },
      { date: "2026-08-02", interactions: 22, unique_users: 5 },
    ],
    top_spaces: [
      { space_name: "design-crit", interactions: 30 },
      { space_name: "on-call", interactions: 12 },
    ],
    ...overrides,
  };
}

describe("WebexStatsSection", () => {
  it("renders nothing when there is no data, not loading, and no error", () => {
    const { container } = render(
      <WebexStatsSection loading={false} rangeLabel="last 30 days" />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the Configured Spaces, Daily Activity, and Top Spaces cards from data", () => {
    render(
      <WebexStatsSection
        loading={false}
        rangeLabel="last 30 days"
        webex={makeWebexStats()}
      />
    );

    expect(screen.getByText("Webex")).toBeInTheDocument();
    expect(screen.getByText("Configured Spaces")).toBeInTheDocument();
    expect(screen.getByText("3", { selector: "p.text-3xl" })).toBeInTheDocument();
    expect(
      screen.getByText(
        (_, element) => element?.textContent === "Daily Webex Activity (last 30 days)"
      )
    ).toBeInTheDocument();
    expect(screen.getByText("Top Spaces")).toBeInTheDocument();
    expect(screen.getByText("design-crit")).toBeInTheDocument();
    expect(screen.getByText("on-call")).toBeInTheDocument();
    // No escalation concept for Webex — the Slack-only "Escalated" stat must not appear.
    expect(screen.queryByText("Escalated")).not.toBeInTheDocument();
  });

  it("shows an empty state for Top Spaces when there is no space data yet", () => {
    render(
      <WebexStatsSection
        loading={false}
        rangeLabel="last 30 days"
        webex={makeWebexStats({ top_spaces: [] })}
      />
    );

    expect(screen.getByText("No space data yet")).toBeInTheDocument();
  });

  it("omits the Configured Spaces card when configured_spaces is absent (user-filtered view)", () => {
    const stats = makeWebexStats();
    delete (stats as Partial<AdminWebexStats>).configured_spaces;
    delete (stats as Partial<AdminWebexStats>).configured_spaces_daily;

    render(
      <WebexStatsSection loading={false} rangeLabel="last 30 days" webex={stats} />
    );

    expect(screen.queryByText("Configured Spaces")).not.toBeInTheDocument();
  });

  it("renders loading and error state via AsyncStatsCard", () => {
    render(
      <WebexStatsSection
        loading
        error="Failed to load webex"
        rangeLabel="last 30 days"
      />
    );

    expect(screen.getByTestId("stats-card-webex-top-spaces")).toHaveAttribute("aria-busy", "true");
  });
});
