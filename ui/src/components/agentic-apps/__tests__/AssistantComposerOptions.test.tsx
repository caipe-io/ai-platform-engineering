import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { useAppAssistantPresentation, useAssistantComposerOptions } from "../AssistantComposerOptions";
import { rememberAssistantPresentation } from "@/lib/agentic-apps/assistant-presentation";
import type { AssistantOptions } from "../../../../app-sdk/assistant-options.mjs";

let mockSubject = "primary-user";
jest.mock("next-auth/react", () => ({ useSession: () => ({ status: "authenticated", data: { sub: mockSubject } }) }));

const app = {
  appId: "example-app", canLaunch: true, assistantAgentId: "example-agent", assistantLabel: "Ask Example",
  assistantOptions: { version: "1.0", controls: [{ id: "sources", label: "Search sources", requestKey: "verify_sources", defaultChoice: "published",
    choices: [{ id: "published", label: "Published only", value: false }, { id: "verify", label: "Verify sources", value: true }] }],
    presentation: { feedbackPrompt: { message: "", actionLabel: "Report feedback" } } },
};

function FullPagePresentation({ agentId = "example-agent" }: { agentId?: string }) {
  const { app: resolved, configuration } = useAppAssistantPresentation("example-app", agentId);
  const { requestOptions, composerHeader } = useAssistantComposerOptions(resolved?.assistantOptions, configuration);
  return <div><span>{resolved?.assistantLabel}</span>{composerHeader}<output>{JSON.stringify(requestOptions)}</output><span>{resolved?.assistantOptions?.presentation?.feedbackPrompt?.actionLabel}</span></div>;
}

beforeEach(() => {
  window.localStorage.clear();
  mockSubject = "primary-user";
  jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, json: async () => ({ item: app }) } as Response);
});
afterEach(() => jest.restoreAllMocks());

it("offers the app's source choices and feedback copy in full-page chat", async () => {
  render(<FullPagePresentation />);
  expect(await screen.findByText("Ask Example")).toBeInTheDocument();
  expect(screen.getByText("Report feedback")).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent('{"verify_sources":false}');
  fireEvent.change(screen.getByLabelText("Search sources"), { target: { value: "verify" } });
  expect(screen.getByRole("status")).toHaveTextContent('{"verify_sources":true}');
});

it("does not adopt options when the resolved app is bound to a different agent", async () => {
  render(<FullPagePresentation agentId="secondary-agent" />);
  await waitFor(() => expect(fetch).toHaveBeenCalled());
  expect(screen.queryByText("Ask Example")).toBeNull();
  expect(screen.queryByLabelText("Search sources")).toBeNull();
});

it("hides prior app options immediately on account changes and ignores stale responses", async () => {
  const view = render(<FullPagePresentation />);
  await screen.findByText("Ask Example");
  let resolve!: (value: Response) => void;
  jest.mocked(fetch).mockReturnValueOnce(new Promise(done => { resolve = done; }));
  mockSubject = "secondary-user";
  view.rerender(<FullPagePresentation />);
  expect(screen.queryByText("Ask Example")).toBeNull();
  mockSubject = "third-user";
  jest.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ item: { ...app, canLaunch: false } }) } as Response);
  view.rerender(<FullPagePresentation />);
  await act(async () => { resolve({ ok: true, json: async () => ({ item: app }) } as Response); });
  expect(screen.queryByText("Ask Example")).toBeNull();
});

it("uses the popup's current source availability rather than offering unavailable choices", async () => {
  const configuredApp = { ...app, assistantOptions: { ...app.assistantOptions, requireConfiguration: true } };
  jest.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ item: configuredApp }) } as Response);
  render(<FullPagePresentation />);
  await screen.findByText("Ask Example");
  expect(screen.queryByLabelText("Search sources")).toBeNull();
  const session = { sub: mockSubject, expires: "2026-01-01" };
  const configuration = { version: "1.0" as const, visible: true, controls: { sources: { choices: ["published", "verify"], defaultChoice: "published" } } };
  act(() => rememberAssistantPresentation("example-app", "example-agent", session, configuration, configuredApp.assistantOptions as AssistantOptions));
  expect(await screen.findByLabelText("Search sources")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Search sources"), { target: { value: "verify" } });
  expect(screen.getByRole("status")).toHaveTextContent('{"verify_sources":true}');
  act(() => rememberAssistantPresentation("example-app", "example-agent", session,
    { ...configuration, controls: { sources: { choices: ["published"], defaultChoice: "published" } } }, configuredApp.assistantOptions as AssistantOptions));
  expect(screen.queryByLabelText("Search sources")).toBeNull();
  expect(screen.getByRole("status")).toHaveTextContent('{"verify_sources":false}');
});
