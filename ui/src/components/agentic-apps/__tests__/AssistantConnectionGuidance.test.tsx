import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AssistantConnectionGuidance, ConnectionGuideButtons } from "../AssistantConnectionGuidance";

jest.mock("@/components/shared/timeline/MarkdownRenderer", () => ({ MarkdownRenderer: ({ content }: { content: string }) => <p>{content}</p> }));

const guide = { id: "channel-1", enabled: true, label: "Connect via Webex", logo: "webex" as const, title: "Webex instructions", markdown: "Search for example-bot@example.test", action_label: "Link identity", action_url: "/api/auth/webex-link/start" };

test("opens Webex instructions from a logo and keeps them open until closed", async () => {
  render(<ConnectionGuideButtons guides={[guide, { ...guide, id: "slack", enabled: false, label: "Connect to Slack" }]} />);
  const trigger = screen.getByRole("button", { name: "Connect via Webex" });
  expect(trigger.querySelector("img")).toHaveAttribute("src", "/provider-logos/webex.svg");
  expect(screen.queryByRole("button", { name: "Connect to Slack" })).not.toBeInTheDocument();

  fireEvent.click(trigger);
  expect(await screen.findByRole("dialog", { name: "Webex instructions" })).toBeVisible();
  await waitFor(() => expect(screen.getByRole("dialog", { name: "Webex instructions" })).toHaveFocus());
  expect(screen.getByText("Search for example-bot@example.test")).toBeVisible();
  expect(screen.getByRole("link", { name: "Link identity" })).toHaveAttribute("href", "/api/auth/webex-link/start");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  fireEvent.mouseDown(document.body);
  expect(screen.getByRole("dialog", { name: "Webex instructions" })).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "Close connection instructions" }));
  expect(screen.queryByRole("dialog", { name: "Webex instructions" })).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

test("Escape closes the instructions without closing the surrounding assistant", async () => {
  const closeAssistant = jest.fn();
  const onOuterEscape = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) closeAssistant(); };
  window.addEventListener("keydown", onOuterEscape);
  try {
    render(<ConnectionGuideButtons guides={[guide]} />);
    const trigger = screen.getByRole("button", { name: "Connect via Webex" });
    fireEvent.click(trigger);
    expect(await screen.findByRole("dialog", { name: "Webex instructions" })).toBeVisible();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Webex instructions" })).not.toBeInTheDocument();
    expect(closeAssistant).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();
  } finally {
    window.removeEventListener("keydown", onOuterEscape);
  }
});

test("shows the button label when no Webex logo is configured", () => {
  render(<ConnectionGuideButtons guides={[
    { ...guide, id: "webex", logo: undefined },
    { ...guide, id: "slack", label: "Connect to Slack", logo: undefined },
  ]} />);
  expect(screen.getByRole("button", { name: "Connect via Webex" })).toHaveTextContent("Connect via Webex");
  expect(screen.getByRole("button", { name: "Connect to Slack" })).toHaveTextContent("Connect to Slack");
  expect(screen.getByRole("button", { name: "Connect to Slack" }).querySelector("img")).toBeNull();
});

 test("hides unsafe connection actions", async () => {
  render(<ConnectionGuideButtons guides={[{ ...guide, action_url: "javascript:alert(1)" }]} />);
  fireEvent.click(screen.getByRole("button", { name: "Connect via Webex" }));
  await screen.findByRole("dialog");
  expect(screen.queryByRole("link", { name: "Link identity" })).not.toBeInTheDocument();
});

test("shows a retry when published guidance cannot load", async () => {
  const previous = global.fetch;
  global.fetch = jest.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true, json: async () => ({ data: { guides: [guide] } }) });
  try {
    render(<AssistantConnectionGuidance appId="example" />);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: "Connect via Webex" })).toBeVisible();
  } finally { global.fetch = previous; }
});
