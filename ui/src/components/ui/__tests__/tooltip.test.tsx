import { fireEvent, render, screen } from "@testing-library/react";

import { Tooltip, TooltipContent, TooltipTrigger } from "../tooltip";

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, x: left, y: top, right: left + width, bottom: top + height, toJSON: () => ({}) };
}

describe("Tooltip viewport bounds", () => {
  let triggerRect: DOMRect;
  let contentRect: DOMRect;

  beforeEach(() => {
    triggerRect = rect(400, 300, 40, 20);
    contentRect = rect(0, 0, 200, 100);
    jest.replaceProperty(window, "innerWidth", 1000);
    jest.replaceProperty(window, "innerHeight", 800);
    jest.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("role") === "tooltip" ? contentRect : triggerRect;
    });
    jest.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(100);
  });

  afterEach(() => jest.restoreAllMocks());

  function renderTooltip(side: "top" | "bottom" | "left" | "right") {
    return render(
      <Tooltip open>
        <TooltipTrigger asChild><button type="button">Help</button></TooltipTrigger>
        <TooltipContent side={side}>Example explanation</TooltipContent>
      </Tooltip>,
    );
  }

  it.each(["top", "bottom"] as const)("clamps a %s tooltip at both horizontal edges", (side) => {
    triggerRect = rect(0, 300, 40, 20);
    renderTooltip(side);
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveStyle({ left: "108px" });

    triggerRect = rect(960, 300, 40, 20);
    fireEvent(window, new Event("resize"));
    expect(tooltip).toHaveStyle({ left: "892px" });
  });

  it("keeps a left-side tooltip inside the left gutter", () => {
    triggerRect = rect(20, 300, 40, 20);
    renderTooltip("left");
    expect(screen.getByRole("tooltip")).toHaveStyle({ left: "208px" });
  });

  it("keeps a right-side tooltip inside the right gutter", () => {
    triggerRect = rect(960, 300, 40, 20);
    renderTooltip("right");
    expect(screen.getByRole("tooltip")).toHaveStyle({ left: "792px" });
  });

  it("remeasures the visible bounds when the viewport and content change", () => {
    renderTooltip("bottom");
    jest.replaceProperty(window, "innerWidth", 400);
    contentRect = rect(0, 0, 300, 100);
    fireEvent(window, new Event("resize"));
    expect(screen.getByRole("tooltip")).toHaveStyle({ left: "242px" });
  });

  it("uses the rendered height rather than the smaller layout height", () => {
    triggerRect = rect(400, 10, 40, 20);
    contentRect = rect(0, 0, 200, 150);
    renderTooltip("top");
    expect(screen.getByRole("tooltip")).toHaveStyle({ top: "158px" });
  });

  it("keeps long tooltip content horizontally scrollable within the viewport", () => {
    renderTooltip("bottom");
    expect(screen.getByRole("tooltip")).toHaveClass("max-w-[calc(100vw-1rem)]", "overflow-x-auto");
  });

  it("preserves unclamped positioning when there is enough room", () => {
    renderTooltip("bottom");
    expect(screen.getByRole("tooltip")).toHaveStyle({ left: "420px", top: "324px" });
  });
});
