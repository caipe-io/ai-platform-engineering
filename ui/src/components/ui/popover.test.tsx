import { act, fireEvent, render, screen } from "@testing-library/react";

import { Popover, PopoverContent, PopoverTrigger } from "./popover";

it.each([false, true])("focuses initially open content without ResizeObserver (portalled=%s)", portalled => {
  const originalResizeObserver = global.ResizeObserver;
  Object.defineProperty(global, "ResizeObserver", { configurable: true, writable: true, value: undefined });
  const onOpenAutoFocus = jest.fn((content: HTMLDivElement) => content.querySelector("button")?.focus());
  try {
    render(
      <Popover defaultOpen>
        <PopoverTrigger asChild><button type="button">Destinations</button></PopoverTrigger>
        <PopoverContent portalled={portalled} onOpenAutoFocus={onOpenAutoFocus}>
          <button type="button">Initial destination</button>
        </PopoverContent>
      </Popover>,
    );
    expect(screen.getByRole("button", { name: "Initial destination" })).toHaveFocus();
    expect(onOpenAutoFocus).toHaveBeenCalledTimes(1);
  } finally {
    Object.defineProperty(global, "ResizeObserver", { configurable: true, writable: true, value: originalResizeObserver });
  }
});

it("runs opening focus after placement and does not steal it during repositioning", () => {
  const onOpenAutoFocus = jest.fn((content: HTMLDivElement) => content.querySelector("button")?.focus());
  render(
    <Popover>
      <PopoverTrigger asChild><button type="button">Open destinations</button></PopoverTrigger>
      <PopoverContent onOpenAutoFocus={onOpenAutoFocus}>
        <button type="button">First destination</button>
        <button type="button">Second destination</button>
      </PopoverContent>
    </Popover>,
  );
  const trigger = screen.getByRole("button", { name: "Open destinations" });
  fireEvent.click(trigger);
  expect(screen.getByRole("button", { name: "First destination" })).toHaveFocus();
  expect(onOpenAutoFocus).toHaveBeenCalledTimes(1);
  screen.getByRole("button", { name: "Second destination" }).focus();
  fireEvent(window, new Event("resize"));
  expect(screen.getByRole("button", { name: "Second destination" })).toHaveFocus();
  expect(onOpenAutoFocus).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(trigger).toHaveFocus();
  fireEvent.click(trigger);
  expect(screen.getByRole("button", { name: "First destination" })).toHaveFocus();
  expect(onOpenAutoFocus).toHaveBeenCalledTimes(2);
});

it("renders portaled content as an interactive layer above dialog overlays", () => {
  render(
    <Popover>
      <PopoverTrigger asChild>
        <button type="button">Open picker</button>
      </PopoverTrigger>
      <PopoverContent>
        <button type="button">Selectable option</button>
      </PopoverContent>
    </Popover>
  );

  fireEvent.click(screen.getByRole("button", { name: "Open picker" }));

  const content = screen.getByRole("button", { name: "Selectable option" }).parentElement;
  expect(content).toHaveClass("pointer-events-auto");
  expect(content).toHaveClass("z-[60]");
});

it("remeasures both the trigger and async content while open", () => {
  const originalResizeObserver = global.ResizeObserver;
  const observe = jest.fn();
  const disconnect = jest.fn();
  let notifyResize: ResizeObserverCallback = () => undefined;

  class MockResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      notifyResize = callback;
    }

    observe = observe;
    unobserve = jest.fn();
    disconnect = disconnect;
  }

  Object.defineProperty(global, "ResizeObserver", {
    configurable: true,
    value: MockResizeObserver,
    writable: true,
  });

  const { unmount } = render(
    <Popover>
      <PopoverTrigger asChild>
        <button type="button">Open async menu</button>
      </PopoverTrigger>
      <PopoverContent>
        <button type="button">Loaded option</button>
      </PopoverContent>
    </Popover>,
  );

  const trigger = screen.getByRole("button", { name: "Open async menu" });
  fireEvent.click(trigger);
  const content = screen.getByRole("button", { name: "Loaded option" }).closest(
    "[data-popover-content]",
  );

  expect(content).not.toBeNull();
  expect(observe).toHaveBeenCalledWith(trigger);
  expect(observe).toHaveBeenCalledWith(content);

  act(() => notifyResize([], {} as ResizeObserver));
  unmount();
  expect(disconnect).toHaveBeenCalledTimes(1);

  Object.defineProperty(global, "ResizeObserver", {
    configurable: true,
    value: originalResizeObserver,
    writable: true,
  });
});

it("closes on Escape and returns focus to the trigger", () => {
  render(
    <Popover>
      <PopoverTrigger asChild>
        <button type="button">Open picker</button>
      </PopoverTrigger>
      <PopoverContent>
        <button type="button">Selectable option</button>
      </PopoverContent>
    </Popover>,
  );

  const trigger = screen.getByRole("button", { name: "Open picker" });
  fireEvent.click(trigger);
  screen.getByRole("button", { name: "Selectable option" }).focus();
  fireEvent.keyDown(document, { key: "Escape" });

  expect(
    screen.queryByRole("button", { name: "Selectable option" }),
  ).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

it("clamps the final bounds after a scale animation ends", () => {
  let contentHeight = 475;
  const measure = jest.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const content = this.hasAttribute("data-popover-content");
    const top = content ? 0 : 360;
    const height = content ? contentHeight : 36;
    return { top, bottom: top + height, left: 600, right: 1050, width: 450, height, x: 600, y: top, toJSON: () => ({}) } as DOMRect;
  });
  try {
    render(<Popover>
      <PopoverTrigger><span>Open animated guide</span></PopoverTrigger>
      <PopoverContent>Runtime comparison</PopoverContent>
    </Popover>);
    fireEvent.click(screen.getByRole("button", { name: "Open animated guide" }));
    const content = screen.getByText("Runtime comparison");
    expect(content.style.top).toBe(`${window.innerHeight - 475 - 8}px`);
    contentHeight = 500;
    fireEvent.animationEnd(content);
    expect(content.style.top).toBe(`${window.innerHeight - 500 - 8}px`);
  } finally {
    measure.mockRestore();
  }
});

it("does not open an aria-disabled custom trigger", () => {
  render(
    <Popover>
      <PopoverTrigger asChild>
        <div role="button" aria-disabled="true" tabIndex={-1}>
          Disabled picker
        </div>
      </PopoverTrigger>
      <PopoverContent>Picker content</PopoverContent>
    </Popover>,
  );

  fireEvent.click(screen.getByRole("button", { name: "Disabled picker" }));
  expect(screen.queryByText("Picker content")).not.toBeInTheDocument();
});
