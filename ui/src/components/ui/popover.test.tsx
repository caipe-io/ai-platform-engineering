import { act, fireEvent, render, screen } from "@testing-library/react";

import { Popover, PopoverContent, PopoverTrigger } from "./popover";

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
