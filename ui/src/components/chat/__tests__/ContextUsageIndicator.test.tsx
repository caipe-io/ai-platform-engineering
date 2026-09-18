/**
 * @jest-environment jsdom
 */

import { render,screen } from "@testing-library/react";

import { ContextUsageIndicator } from "../ContextUsageIndicator";

describe("ContextUsageIndicator",() => {
  it("shows the remaining percentage before compaction",() => {
    render(
      <ContextUsageIndicator
        usage={{
          used_tokens: 25_000,
          compaction_threshold: 100_000,
          remaining_tokens: 75_000,
          remaining_percent: 75,
        }}
      />,
    );

    expect(screen.getByRole("status")).toHaveAccessibleName(
      "75% context left before compaction",
    );
    expect(screen.getByText("75% context left")).toBeInTheDocument();
  });
});
