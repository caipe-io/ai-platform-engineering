/**
 * Unit tests for SimpleLineChart component
 *
 * Tests:
 * - Renders SVG chart
 * - Shows data points
 * - Handles empty data
 * - Renders with correct dimensions
 * - Shows labels if provided
 * - Title when provided
 * - Show grid option
 */

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";

// ============================================================================
// Imports — no mocks needed for SimpleLineChart
// ============================================================================

import { SimpleLineChart } from "../SimpleLineChart";

// ============================================================================
// Tests
// ============================================================================

describe("SimpleLineChart", () => {
  const sampleData = [
    { label: "Jan", value: 10 },
    { label: "Feb", value: 25 },
    { label: "Mar", value: 15 },
    { label: "Apr", value: 40 },
    { label: "May", value: 30 },
  ];

  it("renders SVG chart", () => {
    const { container } = render(<SimpleLineChart data={sampleData} />);
    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
  });

  it("shows data points", () => {
    const { container } = render(<SimpleLineChart data={sampleData} />);
    const circles = container.querySelectorAll("circle");
    expect(circles.length).toBe(sampleData.length);
  });

  it("handles empty data", () => {
    render(<SimpleLineChart data={[]} />);
    expect(screen.getByText("No data available")).toBeInTheDocument();
  });

  it("renders with correct dimensions", () => {
    const { container } = render(
      <SimpleLineChart data={sampleData} height={300} />
    );
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("height", "300");
  });

  it("shows labels if provided", () => {
    const { container } = render(<SimpleLineChart data={sampleData} />);
    expect(container.textContent).toContain("Jan");
    expect(container.textContent).toContain("Feb");
    expect(container.textContent).toContain("May");
  });

  it("shows title when provided", () => {
    render(<SimpleLineChart data={sampleData} title="Monthly Stats" />);
    expect(screen.getByText("Monthly Stats")).toBeInTheDocument();
  });

  it("hides title when not provided", () => {
    render(<SimpleLineChart data={sampleData} />);
    expect(screen.queryByRole("heading", { level: 4 })).not.toBeInTheDocument();
  });

  it("renders with custom color", () => {
    const { container } = render(
      <SimpleLineChart data={sampleData} color="rgb(255, 0, 0)" />
    );
    const path = container.querySelector("path[stroke]");
    expect(path).toHaveAttribute("stroke", "rgb(255, 0, 0)");
  });

  it("shows hover tooltip with label and value on mouse move", () => {
    const { container } = render(<SimpleLineChart data={sampleData} />);
    const svg = container.querySelector("svg")!;

    // getBoundingClientRect is not implemented in jsdom, mock it
    svg.getBoundingClientRect = () => ({
      left: 0, top: 0, right: 800, bottom: 200,
      width: 800, height: 200, x: 0, y: 0, toJSON: () => {},
    });

    // Move mouse to roughly the middle of the chart (should resolve to a data point)
    fireEvent.mouseMove(svg, { clientX: 400, clientY: 100 });

    // A tooltip text element should now be visible with one of the data labels
    const texts = container.querySelectorAll("tspan");
    const hasDataLabel = Array.from(texts).some(
      (t) => sampleData.some((d) => t.textContent?.includes(d.label))
    );
    expect(hasDataLabel).toBe(true);
  });

  it("stretches to fill non-square render widths so edge hover lines up with the drawn points", () => {
    // Regression test: the SVG viewBox is 800x200. Without preserveAspectRatio="none",
    // the browser's default "xMidYMid meet" scaling letterboxes the content whenever the
    // rendered box's aspect ratio differs from the viewBox's (e.g. a "wide" chart whose
    // rendered width is wider than 800px), so the drawn line no longer spans the full box
    // and the hover math (which assumes a 1:1 stretch) misses the leftmost/rightmost points
    // near the edges. Asserting the attribute directly is the reliable way to catch this in
    // jsdom, since jsdom does not implement real SVG viewport scaling.
    const { container } = render(<SimpleLineChart data={sampleData} />);
    const svg = container.querySelector("svg")!;
    expect(svg).toHaveAttribute("preserveAspectRatio", "none");
  });

  it("resolves hover to the first and last data point at the rendered box's left/right edges", () => {
    const { container } = render(<SimpleLineChart data={sampleData} />);
    const svg = container.querySelector("svg")!;

    // A "wide" chart: rendered wider than the 800-unit viewBox, the scenario that exposed
    // the letterboxing bug in a real browser.
    svg.getBoundingClientRect = () => ({
      left: 0, top: 0, right: 1200, bottom: 200,
      width: 1200, height: 200, x: 0, y: 0, toJSON: () => {},
    });

    fireEvent.mouseMove(svg, { clientX: 0, clientY: 100 });
    let texts = container.querySelectorAll("tspan");
    expect(Array.from(texts).some((t) => t.textContent?.includes(sampleData[0].label))).toBe(true);

    fireEvent.mouseMove(svg, { clientX: 1200, clientY: 100 });
    texts = container.querySelectorAll("tspan");
    expect(
      Array.from(texts).some((t) => t.textContent?.includes(sampleData[sampleData.length - 1].label))
    ).toBe(true);
  });

  it("matches the viewBox width to the actual rendered width to avoid anisotropic stretching", () => {
    // Regression test: a fixed 800-unit viewBox stretched via preserveAspectRatio="none" onto
    // a much wider rendered box (e.g. a 1200px-wide dashboard card) scales X and Y unevenly,
    // turning circular data points into ellipses and distorting stroke widths and text glyphs.
    // The component measures its own rendered width on mount and uses that as the viewBox
    // width instead, so the scale factor is always ~1:1 in both axes.
    const originalGetBoundingClientRect = SVGSVGElement.prototype.getBoundingClientRect;
    SVGSVGElement.prototype.getBoundingClientRect = () => ({
      left: 0, top: 0, right: 1200, bottom: 200,
      width: 1200, height: 200, x: 0, y: 0, toJSON: () => {},
    });
    try {
      const { container } = render(<SimpleLineChart data={sampleData} />);
      const svg = container.querySelector("svg")!;
      expect(svg).toHaveAttribute("viewBox", "0 0 1200 200");
    } finally {
      SVGSVGElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    }
  });

  it("falls back to the default 800-unit viewBox when the rendered width can't be measured", () => {
    // jsdom's default getBoundingClientRect returns width 0, which must be ignored rather
    // than collapsing the chart's coordinate space.
    const { container } = render(<SimpleLineChart data={sampleData} />);
    const svg = container.querySelector("svg")!;
    expect(svg).toHaveAttribute("viewBox", "0 0 800 200");
  });

  it("renders drag selection with % change badge after drag across two points", () => {
    // Data: 10 → 20 = +100%
    const dragData = [
      { label: "A", value: 10 },
      { label: "B", value: 15 },
      { label: "C", value: 20 },
    ];
    const { container } = render(<SimpleLineChart data={dragData} />);
    const svg = container.querySelector("svg")!;

    svg.getBoundingClientRect = () => ({
      left: 0, top: 0, right: 800, bottom: 200,
      width: 800, height: 200, x: 0, y: 0, toJSON: () => {},
    });

    // Drag from left edge (point A, index 0) to right edge (point C, index 2)
    fireEvent.mouseDown(svg, { clientX: 50 });   // near left padding → index 0
    fireEvent.mouseMove(svg, { clientX: 750 });   // near right edge → index 2
    fireEvent.mouseUp(svg);

    // The % change badge should show +100.0%
    const allText = container.textContent || "";
    expect(allText).toContain("+100.0%");
    // And the range label "A → C"
    expect(allText).toContain("A");
    expect(allText).toContain("C");
  });
});
