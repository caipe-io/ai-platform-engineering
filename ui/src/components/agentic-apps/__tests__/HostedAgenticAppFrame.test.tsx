import { act, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { HostedAgenticAppFrame } from "../HostedAgenticAppFrame";
import { applyInterfaceShadows } from "@/lib/appearance-preferences";

let mockTheme = "dark";
jest.mock("@/components/theme-provider", () => ({ useTheme: () => ({ resolvedTheme: mockTheme }) }));
afterEach(() => { jest.restoreAllMocks(); mockTheme = "dark"; localStorage.clear(); document.documentElement.removeAttribute("data-interface-shadows"); });

it("preserves the assistant iframe ref and load callback", () => {
  const ref = createRef<HTMLIFrameElement>();
  const onLoad = jest.fn();
  render(<HostedAgenticAppFrame appId="example" title="Example" ref={ref} onLoad={onLoad} />);
  const frame = screen.getByTitle("Example");
  expect(ref.current).toBe(frame);
  fireEvent.load(frame);
  expect(onLoad).toHaveBeenCalledTimes(1);
});

it("sends live presentation context on load and host theme changes, without identity", () => {
  const { rerender } = render(<HostedAgenticAppFrame appId="example" title="Example" src="/apps/example" />);
  const frame = screen.getByTitle("Example") as HTMLIFrameElement;
  const post = jest.spyOn(frame.contentWindow!, "postMessage");
  fireEvent.load(frame);
  expect(post).toHaveBeenLastCalledWith(expect.objectContaining({
    appId: "example", context: expect.objectContaining({ theme: "dark", preferences: { shadows_enabled: false } }),
  }), window.location.origin);
  mockTheme = "legacy-light";
  rerender(<HostedAgenticAppFrame appId="example" title="Example" src="/apps/example" />);
  const message = post.mock.calls.at(-1)?.[0];
  expect(message.context.theme).toBe("light");
  expect(JSON.stringify(message)).not.toMatch(/token|cookie|session|email|authorization/i);
});

it("publishes a shadow change without changing the iframe document", () => {
  render(<HostedAgenticAppFrame appId="example" title="Example" src="/apps/example" />);
  const frame = screen.getByTitle("Example") as HTMLIFrameElement;
  const post = jest.spyOn(frame.contentWindow!, "postMessage");
  act(() => applyInterfaceShadows(true));
  expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ context: expect.objectContaining({ preferences: { shadows_enabled: true } }) }), window.location.origin);
  expect(screen.getByTitle("Example")).toBe(frame);
  expect(frame.getAttribute("src")).toBe("/apps/example");
});

it("validates ready-message origin, source and app and prevents acknowledgement loops", () => {
  render(<HostedAgenticAppFrame appId="example" title="Example" src="/apps/example" />);
  const frame = screen.getByTitle("Example") as HTMLIFrameElement;
  const post = jest.spyOn(frame.contentWindow!, "postMessage");
  const data = { type: "caipe.microfrontend.ready.v1", version: "1.0", appId: "example" };
  const send = (origin: string, source: MessageEventSource | null, payload = data) => act(() => {
    window.dispatchEvent(new MessageEvent("message", { origin, source, data: payload }));
  });
  send("https://other.example.test", frame.contentWindow);
  send(window.location.origin, window);
  send(window.location.origin, frame.contentWindow, { ...data, appId: "other" });
  expect(post).not.toHaveBeenCalled();
  send(window.location.origin, frame.contentWindow);
  send(window.location.origin, frame.contentWindow);
  expect(post).toHaveBeenCalledTimes(1);
});
