import { render, screen } from "@testing-library/react";

import { ApiStatsSection } from "../ApiStatsSection";
import type { AdminApiStats } from "@/types/admin-stats";

function makeApiStats(overrides: Partial<AdminApiStats> = {}): AdminApiStats {
  return {
    total_interactions: 15,
    unique_users: 4,
    daily: [
      { date: "2026-08-01", interactions: 8, unique_users: 2 },
      { date: "2026-08-02", interactions: 7, unique_users: 3 },
    ],
    ...overrides,
  };
}

describe("ApiStatsSection", () => {
  it("renders nothing when there is no data, not loading, and no error", () => {
    const { container } = render(
      <ApiStatsSection loading={false} rangeLabel="last 30 days" />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the Daily API Activity card from data", () => {
    render(
      <ApiStatsSection
        loading={false}
        rangeLabel="last 30 days"
        api={makeApiStats()}
      />
    );

    expect(screen.getByText("API")).toBeInTheDocument();
    expect(
      screen.getByText(
        (_, element) => element?.textContent === "Daily API Activity (last 30 days)"
      )
    ).toBeInTheDocument();
  });

  it("omits the Direct MCP Activity card when mcp_activity is absent (non-admin view)", () => {
    render(
      <ApiStatsSection loading={false} rangeLabel="last 30 days" api={makeApiStats()} />
    );

    expect(screen.queryByText("Direct MCP Activity")).not.toBeInTheDocument();
  });

  it("renders the Direct MCP Activity card totals and daily chart when present", () => {
    render(
      <ApiStatsSection
        loading={false}
        rangeLabel="last 30 days"
        api={makeApiStats({
          mcp_activity: {
            total_events: 120,
            unique_users: 5,
            daily: [
              { date: "2026-08-01", events: 60, unique_users: 3 },
              { date: "2026-08-02", events: 60, unique_users: 4 },
            ],
          },
        })}
      />
    );

    expect(screen.getByText("Direct MCP Activity")).toBeInTheDocument();
    expect(screen.getByText("120")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
  });

  it("shows an unavailable message when the audit service could not be reached", () => {
    render(
      <ApiStatsSection
        loading={false}
        rangeLabel="last 30 days"
        api={makeApiStats({
          mcp_activity: {
            total_events: 0,
            unique_users: 0,
            daily: [],
            unavailable: true,
          },
        })}
      />
    );

    expect(
      screen.getByText("Audit service unavailable — Direct MCP Activity could not be loaded")
    ).toBeInTheDocument();
  });

  it("shows a range-capped note when the selected range exceeds the audit service's retention", () => {
    render(
      <ApiStatsSection
        loading={false}
        rangeLabel="last 90 days"
        api={makeApiStats({
          mcp_activity: {
            total_events: 10,
            unique_users: 2,
            daily: [{ date: "2026-08-01", events: 10, unique_users: 2 }],
            range_capped: true,
          },
        })}
      />
    );

    expect(screen.getByText(/Showing the most recent 31 days/)).toBeInTheDocument();
  });

  it("renders loading and error state via AsyncStatsCard", () => {
    render(
      <ApiStatsSection
        loading
        error="Failed to load api"
        rangeLabel="last 30 days"
      />
    );

    expect(screen.getByTestId("stats-card-api-daily-activity")).toHaveAttribute("aria-busy", "true");
  });
});
