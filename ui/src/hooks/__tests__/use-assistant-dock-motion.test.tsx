import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { useAssistantDockMotion } from "../use-assistant-dock-motion";

function Window({ open, enabled = true }: { open: boolean; enabled?: boolean }) {
  const panel = useRef<HTMLElement>(null), launcher = useRef<HTMLButtonElement>(null);
  const mounted = useAssistantDockMotion(open, enabled, panel, launcher);
  return <>{mounted && <section ref={panel} role="dialog" aria-label="Assistant"><input aria-label="Draft" /><button>Minimize</button></section>}<button ref={launcher}>Open assistant</button></>;
}

type Flight = { frames: Keyframe[]; options: KeyframeAnimationOptions; finish: () => void; cancel: jest.Mock };
let flights: Flight[];
let reduced = false;
const originalAnimate = HTMLElement.prototype.animate;
const originalMatchMedia = window.matchMedia;

beforeEach(() => {
  reduced = false;
  flights = [];
  window.matchMedia = jest.fn().mockImplementation(() => ({ matches: reduced }));
  jest.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.tagName === "SECTION"
      ? { left: 300, top: 100, width: 600, height: 700 } as DOMRect
      : { left: 750, top: 820, width: 150, height: 40 } as DOMRect;
  });
  HTMLElement.prototype.animate = jest.fn().mockImplementation((frames, options) => {
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const cancel = jest.fn();
    flights.push({ frames, options, finish, cancel });
    return { finished, cancel };
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  HTMLElement.prototype.animate = originalAnimate;
  window.matchMedia = originalMatchMedia;
});

it("glides to the launcher, pulses on arrival and preserves the unsent draft", async () => {
  const view = render(<Window open={false} />);
  expect(screen.queryByRole("dialog")).toBeNull();
  view.rerender(<Window open />);
  const panel = screen.getByRole("dialog"), input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "Unsent question" } });
  expect(flights[0].options.duration).toBe(750);
  await act(async () => flights[0].finish());
  screen.getByRole("button", { name: "Minimize" }).focus();
  view.rerender(<Window open={false} />);
  expect(panel).toHaveAttribute("aria-hidden", "true");
  expect(panel.inert).toBe(true);
  expect(flights[1].options.duration).toBe(1050);
  expect(flights[1].frames.at(-1)?.transform).toContain("translate(450px,720px)");
  expect(panel).not.toHaveStyle({ display: "none" });
  await act(async () => flights[1].finish());
  expect(panel).toHaveStyle({ display: "none" });
  expect(screen.getByRole("button", { name: "Open assistant" })).toHaveFocus();
  expect(flights[2].options.duration).toBe(450);
  view.rerender(<Window open />);
  expect(screen.getByRole("dialog")).toBe(panel);
  expect(screen.getByRole("textbox")).toBe(input);
  expect(input).toHaveValue("Unsent question");
  expect(panel.inert).toBe(false);
});

it("cancels a closing flight when reopened and ignores its stale completion", async () => {
  const view = render(<Window open />);
  await act(async () => flights[0].finish());
  view.rerender(<Window open={false} />);
  const closing = flights[1];
  view.rerender(<Window open />);
  expect(closing.cancel).toHaveBeenCalled();
  await act(async () => closing.finish());
  expect(screen.getByRole("dialog")).not.toHaveStyle({ display: "none" });
  expect(flights).toHaveLength(3);
  view.unmount();
  expect(flights[2].cancel).toHaveBeenCalled();
});

it("settles immediately with reduced motion or without Web Animations", () => {
  reduced = true;
  const view = render(<Window open />);
  const panel = screen.getByRole("dialog");
  view.rerender(<Window open={false} />);
  expect(panel).toHaveStyle({ display: "none" });
  expect(flights).toHaveLength(0);
  reduced = false;
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, writable: true, value: undefined });
  view.rerender(<Window open />);
  expect(panel).not.toHaveStyle({ display: "none" });
  view.rerender(<Window open={false} />);
  expect(panel).toHaveStyle({ display: "none" });
});

it("leaves other app assistants on their existing mount behavior", () => {
  const view = render(<Window open enabled={false} />);
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  view.rerender(<Window open={false} enabled={false} />);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(flights).toHaveLength(0);
});
