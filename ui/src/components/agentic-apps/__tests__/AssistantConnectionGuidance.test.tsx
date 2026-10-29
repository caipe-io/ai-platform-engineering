import { fireEvent, render, screen } from "@testing-library/react";
import { ConnectionGuideButtons } from "../AssistantConnectionGuidance";
jest.mock("@/components/shared/timeline/MarkdownRenderer", () => ({ MarkdownRenderer: ({ content }: { content: string }) => <p>{content}</p> }));
const guide = { id: "webex", enabled: true, label: "Connect to Webex", title: "Webex instructions", markdown: "Search for example-bot@example.test", action_label: "Link identity", action_url: "/api/auth/webex-link/start" };
test("opens persistent admin instructions with a link and close control", async () => {
  render(<ConnectionGuideButtons guides={[guide, { ...guide, id: "slack", enabled: false, label: "Connect to Slack" }]} />);
  expect(screen.queryByText("Connect to Slack")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Connect to Webex" }));
  expect(await screen.findByText("Search for example-bot@example.test")).toBeVisible();
  expect(screen.getByRole("link", { name: "Link identity" })).toHaveAttribute("href", "/api/auth/webex-link/start");
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByText("Search for example-bot@example.test")).not.toBeInTheDocument();
});
