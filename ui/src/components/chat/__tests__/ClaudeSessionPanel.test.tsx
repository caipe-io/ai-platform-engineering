import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ClaudeSessionPanel } from "../ClaudeSessionPanel";

it("shows reconnection progress and shared-viewer restrictions", () => {
  const { rerender } = render(<ClaudeSessionPanel activity="checking" readOnly />);
  expect(screen.getByRole("status")).toHaveTextContent("Reconnecting");
  expect(screen.queryByText(/Sending messages or stopping work requires additional access/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Claude session: Reconnecting" }));
  expect(screen.getByText(/Viewing shared session/)).toBeInTheDocument();
  expect(screen.getByText(/Sending messages or stopping work requires additional access/)).toBeInTheDocument();
  rerender(<ClaudeSessionPanel activity="running" readOnly={false} />);
  expect(screen.getByRole("status")).toHaveTextContent("Working");
  expect(screen.queryByText(/Viewing shared session/)).not.toBeInTheDocument();
  expect(screen.getByText(/Refreshing or closing this page does not stop a response/)).toBeInTheDocument();
  rerender(<ClaudeSessionPanel activity="stopping" readOnly={false} />);
  expect(screen.getByRole("status")).toHaveTextContent("Stopping");
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByText(/Refreshing or closing this page does not stop a response/)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Claude session: Stopping" })).toHaveFocus();
});

const sandbox = { instance_id: "sandbox-1", display_name: "Pinned workspace", portal_url: "https://sandbox.example.test/environments/1", policy_revision: "v1", policy_summary: "Private network policy", status: "configured" };

it("loads management details from the retained conversation rather than an agent default", async () => {
  const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { sandbox } }) } as Response);
  try {
    render(<ClaudeSessionPanel activity="idle" readOnly={false} agentId="example-agent" conversationId="original-conversation" />);
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Claude session: Ready" }));
    expect(await screen.findByRole("link", { name: /Manage sandbox/ })).toHaveAttribute("href", sandbox.portal_url);
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/chat/stream/status", expect.objectContaining({ body: JSON.stringify({ agent_id: "example-agent", conversation_id: "original-conversation" }) }));
    expect(screen.getByText(/Deleting this chat does not erase its files/)).toBeInTheDocument();
  } finally { fetchMock.mockRestore(); }
});

it("does not expose sandbox management to a shared viewer", () => {
  const fetchMock = jest.spyOn(global, "fetch");
  try {
    render(<ClaudeSessionPanel activity="idle" readOnly agentId="example-agent" conversationId="shared-conversation" />);
    fireEvent.click(screen.getByRole("button", { name: "Claude session: Ready" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: /Manage sandbox/ })).not.toBeInTheDocument();
  } finally { fetchMock.mockRestore(); }
});

it("drops a late result when the displayed conversation changes", async () => {
  let resolveFirst!: (value: Response) => void;
  const fetchMock = jest.spyOn(global, "fetch")
    .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
    .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, data: {} }) } as Response);
  try {
    const { rerender } = render(<ClaudeSessionPanel activity="idle" readOnly={false} agentId="example-agent" conversationId="first" />);
    fireEvent.click(screen.getByRole("button", { name: "Claude session: Ready" }));
    rerender(<ClaudeSessionPanel activity="idle" readOnly={false} agentId="example-agent" conversationId="second" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => { resolveFirst({ ok: true, json: async () => ({ success: true, data: { sandbox } }) } as Response); });
    expect(screen.queryByRole("link", { name: /Manage sandbox/ })).not.toBeInTheDocument();
  } finally { fetchMock.mockRestore(); }
});
