import { act, fireEvent, render, screen } from "@testing-library/react";
import { HostedAgenticAppFrame } from "../HostedAgenticAppFrame";

let mockTheme = "dark";
jest.mock("@/components/theme-provider", () => ({ useTheme: () => ({ resolvedTheme: mockTheme }) }));
afterEach(() => { jest.restoreAllMocks(); mockTheme = "dark"; });

it("sends live presentation context on load and host theme changes, without identity", () => {
  const { rerender } = render(<HostedAgenticAppFrame appId="example" title="Example" src="/apps/example" />);
  const frame = screen.getByTitle("Example") as HTMLIFrameElement;
  const post = jest.spyOn(frame.contentWindow!, "postMessage");
  fireEvent.load(frame);
  expect(post).toHaveBeenLastCalledWith(expect.objectContaining({
    appId: "example", context: expect.objectContaining({ theme: "dark", preferences: {} }),
  }), window.location.origin);
  mockTheme = "legacy-light";
  rerender(<HostedAgenticAppFrame appId="example" title="Example" src="/apps/example" />);
  const message = post.mock.calls.at(-1)?.[0];
  expect(message.context.theme).toBe("light");
  expect(JSON.stringify(message)).not.toMatch(/token|cookie|session|email|authorization/i);
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
