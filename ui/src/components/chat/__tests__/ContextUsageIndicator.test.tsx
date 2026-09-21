/**
 * @jest-environment jsdom
 */

import { render,screen } from "@testing-library/react";

import { ContextUsageDetails,ContextUsageIndicator } from "../ContextUsageIndicator";

const lowUsage = {
  used_tokens: 71_000,
  compaction_threshold: 100_000,
  remaining_tokens: 29_000,
  remaining_percent: 29,
};

describe("ContextUsageIndicator",() => {
  it("shows a plain status when less than 80 percent remains",() => {
    render(
      <ContextUsageIndicator usage={{ ...lowUsage,remaining_percent: 79 }} />,
    );

    expect(screen.getByRole("status")).toHaveAccessibleName(
      "79% context remaining before compaction",
    );
    expect(screen.getByText("79% context remaining")).toBeInTheDocument();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it.each([80,100])("stays hidden with %s percent remaining",(remainingPercent) => {
    const { container } = render(
      <ContextUsageIndicator
        usage={{ ...lowUsage,remaining_percent: remainingPercent }}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("shows detailed token usage separately for Agent Info",() => {
    render(<ContextUsageDetails usage={lowUsage} />);

    expect(screen.getByText("Context remaining")).toBeInTheDocument();
    expect(screen.getByText("29%")).toBeInTheDocument();
    expect(screen.getByText("71,000 of 100,000 tokens used")).toBeInTheDocument();
    expect(screen.getByText(/compacted automatically/)).toBeInTheDocument();
  });
});
