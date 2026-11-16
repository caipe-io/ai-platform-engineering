import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { ConversationRuntimeMigration } from "../ConversationRuntimeMigration";

const mockToast = jest.fn();
jest.mock("@/components/ui/toast", () => ({ useToast: () => ({ toast: mockToast }) }));
const mockFetch = jest.fn();
const response = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
const status = (state = "available") => response({ success: true, data: { state } });
const migrated = () => response({ success: true, data: { runtime: "harness_engine" } });
const props = { agentId: "example-agent", conversationId: "example-chat", busy: false };

beforeEach(() => {
  jest.clearAllMocks();
  mockFetch.mockReset();
  global.fetch = mockFetch;
  mockFetch.mockImplementation(async (_url: string, options?: RequestInit) => options?.method === "POST" ? migrated() : status());
});

async function openDialog() {
  fireEvent.click(await screen.findByRole("button", { name: "Migrate to Harness Engine" }));
  return screen.getByRole("dialog");
}

it("requires explicit confirmation and preserves the current conversation", async () => {
  render(<><input aria-label="Draft" defaultValue="Unsent example draft" /><ConversationRuntimeMigration {...props} /></>);
  const dialog = await openDialog();
  expect(mockFetch.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(0);
  expect(dialog).toHaveTextContent("Your messages, agent state, files, and pending approvals are preserved");
  fireEvent.click(within(dialog).getByRole("button", { name: "Migrate to Harness Engine" }));
  await waitFor(() => expect(mockToast).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("note")).not.toBeInTheDocument();
  expect(mockFetch).toHaveBeenCalledWith("/api/harness-engine/sessions/migrate", expect.objectContaining({
    method: "POST", body: JSON.stringify({ agent_id: "example-agent", conversation_id: "example-chat", action: "adopt" }),
  }));
  expect(await screen.findByRole("textbox", { name: "Draft" })).toHaveValue("Unsent example draft");
  expect(mockToast).toHaveBeenCalledTimes(1);
});

it.each(["managed", "unavailable"])("does not offer migration when the server reports %s", async state => {
  mockFetch.mockResolvedValue(status(state));
  render(<ConversationRuntimeMigration {...props} />);
  await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  await act(async () => {});
  expect(screen.queryByRole("note")).not.toBeInTheDocument();
});

it.each([true, false])("blocks a live execution detected by the UI or server (local=%s)", async local => {
  mockFetch.mockResolvedValue(status(local ? "available" : "busy"));
  render(<ConversationRuntimeMigration {...props} busy={local} />);
  expect(await screen.findByRole("button", { name: "Migrate to Harness Engine" })).toBeDisabled();
  expect(screen.getByRole("note")).toHaveTextContent("Finish or stop the current response");
  expect(mockFetch.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(0);
});

it("can resume a durable handoff after a page refresh", async () => {
  mockFetch.mockResolvedValueOnce(status("recoverable")).mockResolvedValueOnce(migrated());
  render(<ConversationRuntimeMigration {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "Resume migration" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Resume migration" }));
  await waitFor(() => expect(mockToast).toHaveBeenCalled());
  expect(JSON.parse(mockFetch.mock.calls[1][1].body)).toEqual({ agent_id: "example-agent", conversation_id: "example-chat", action: "adopt" });
});

it("retains a failed handoff for explicit retry instead of sending a prompt", async () => {
  mockFetch.mockResolvedValueOnce(status()).mockResolvedValueOnce(response({ error: "Session reconciliation has not drained" }, 409)).mockResolvedValueOnce(migrated());
  render(<ConversationRuntimeMigration {...props} />);
  const dialog = await openDialog();
  fireEvent.click(within(dialog).getByRole("button", { name: "Migrate to Harness Engine" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Session reconciliation has not drained");
  expect(mockToast).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Retry migration" }));
  await waitFor(() => expect(mockToast).toHaveBeenCalledTimes(1));
  const requests = mockFetch.mock.calls.filter(([, options]) => options?.method === "POST");
  expect(requests).toHaveLength(2);
  expect(requests[0][1].body).toBe(requests[1][1].body);
});

it("does not offer an action when eligibility could not be authorized", async () => {
  mockFetch.mockResolvedValue(response({ error: "Read only" }, 403));
  render(<ConversationRuntimeMigration {...props} />);
  await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  await act(async () => {});
  expect(screen.queryByRole("note")).not.toBeInTheDocument();
});

it("prevents duplicate submissions and waits for a confirmed Engine handoff", async () => {
  let resolve!: (value: Response) => void;
  mockFetch.mockResolvedValueOnce(status()).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  render(<ConversationRuntimeMigration {...props} />);
  const dialog = await openDialog();
  const button = within(dialog).getByRole("button", { name: "Migrate to Harness Engine" });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(within(dialog).getByRole("button", { name: "Migrating…" })).toBeDisabled();
  expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
  expect(mockFetch.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
  expect(mockToast).not.toHaveBeenCalled();
  await act(async () => resolve(migrated()));
  expect(mockToast).toHaveBeenCalledTimes(1);
});

it("does not let an old conversation's response update a different panel", async () => {
  let resolve!: (value: Response) => void;
  mockFetch.mockResolvedValueOnce(status()).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const view = render(<ConversationRuntimeMigration key="primary" {...props} />);
  const dialog = await openDialog();
  fireEvent.click(within(dialog).getByRole("button", { name: "Migrate to Harness Engine" }));
  view.rerender(<ConversationRuntimeMigration key="secondary" {...props} conversationId="secondary-chat" />);
  await screen.findByRole("button", { name: "Migrate to Harness Engine" });
  await act(async () => resolve(migrated()));
  expect(mockToast).not.toHaveBeenCalled();
  expect(screen.getByRole("note")).toBeInTheDocument();
});

it("enables migration when a server-observed execution finishes in another browser", async () => {
  jest.useFakeTimers();
  try {
    mockFetch.mockResolvedValueOnce(status("busy")).mockResolvedValueOnce(status("available"));
    render(<ConversationRuntimeMigration {...props} />);
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Migrate to Harness Engine" })).toBeDisabled();
    await act(async () => { await jest.advanceTimersByTimeAsync(5_000); });
    expect(screen.getByRole("button", { name: "Migrate to Harness Engine" })).toBeEnabled();
    expect(mockFetch.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(0);
  } finally { jest.useRealTimers(); }
});
