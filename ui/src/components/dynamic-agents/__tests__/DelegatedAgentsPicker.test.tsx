import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DelegatedAgentsPicker } from "../DelegatedAgentsPicker";

const local = { _id: "same-id", name: "Coding specialist", description: "Read-only coding", visibility: "global", execution_harness_id: "claude_code_cli_acp" };
const a2a = { _id: "same-id", name: "Network specialist", description: "DNS checks", timeout_seconds: 120 };
function response(data: unknown, ok = true) { return { ok, json: async () => ({ success: ok, data, error: ok ? undefined : "Registry unavailable" }) }; }
function props() { return { agentId: null, value: [], onChange: jest.fn(), parentVisibility: "team" as const, allowHarnessChildren: true,
  remote: { value: [], onChange: jest.fn(), timeoutValues: {}, onTimeoutChange: jest.fn() } }; }
beforeEach(() => { global.fetch = jest.fn(async url => String(url).includes("remote-agents") ? response({ items: [a2a] }) : response({ agents: [local] })) as jest.Mock; });

it("uses one picker and preserves distinct CAIPE and A2A references with matching IDs", async () => {
  const selection = props();
  const view = render(<DelegatedAgentsPicker {...selection} />);
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Add subagent" })).not.toBeDisabled());
  fireEvent.click(screen.getByRole("combobox", { name: "Add subagent" }));
  fireEvent.click(await screen.findByRole("option", { name: /Coding specialist/ }));
  const ref = { agent_id: "same-id", name: "coding-specialist", description: "Read-only coding" };
  expect(selection.onChange).toHaveBeenCalledWith([ref]);
  view.rerender(<DelegatedAgentsPicker {...selection} value={[ref]} />);
  fireEvent.click(screen.getByRole("combobox", { name: "Add subagent" }));
  fireEvent.click(await screen.findByRole("option", { name: /Network specialist/ }));
  expect(selection.remote.onChange).toHaveBeenCalledWith(["same-id"]);
  expect(screen.getByRole("link", { name: "Discover remote agents" })).toHaveAttribute("target", "_blank");
});

it("edits the child deadline and removes only parent references", async () => {
  const selection = props();
  const ref = { agent_id: "same-id", name: "code", description: "Coding", timeout_seconds: 45 };
  render(<DelegatedAgentsPicker {...selection} value={[ref]} remote={{ ...selection.remote, value: ["same-id"] }} />);
  await screen.findByText("Coding specialist");
  fireEvent.change(screen.getAllByRole("spinbutton", { name: "Timeout (seconds)" })[0], { target: { value: "60" } });
  expect(selection.onChange).toHaveBeenCalledWith([{ ...ref, timeout_seconds: 60 }]);
  fireEvent.click(screen.getByRole("button", { name: "Remove Network specialist subagent" }));
  expect(selection.remote.onChange).toHaveBeenCalledWith([]);
  expect((global.fetch as jest.Mock).mock.calls.every(([, options]) => !options.method || options.method === "GET")).toBe(true);
});

it("keeps saved references when the registry fails and leaves authorized CAIPE choices usable", async () => {
  global.fetch = jest.fn(async url => String(url).includes("remote-agents") ? response(undefined, false) : response({ agents: [local] })) as jest.Mock;
  const selection = props();
  render(<DelegatedAgentsPicker {...selection} remote={{ ...selection.remote, value: ["missing-remote"] }} />);
  await screen.findByRole("alert");
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Add subagent" })).not.toBeDisabled());
  expect(screen.getByText("missing-remote")).toBeInTheDocument();
  expect(selection.remote.onChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("combobox", { name: "Add subagent" }));
  expect(await screen.findByRole("option", { name: /Coding specialist/ })).toBeEnabled();
});

it("disables incompatible sharing", async () => {
  global.fetch = jest.fn(async url => String(url).includes("remote-agents") ? response({ items: [] }) : response({ agents: [{ ...local, visibility: "team" }] })) as jest.Mock;
  const selection = props();
  render(<DelegatedAgentsPicker {...selection} parentVisibility="global" />);
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Add subagent" })).not.toBeDisabled());
  fireEvent.click(screen.getByRole("combobox", { name: "Add subagent" }));
  expect(await screen.findByRole("option", { name: /Coding specialist/ })).toBeDisabled();
});

it("keeps Harness children disabled against older backends", async () => {
  render(<DelegatedAgentsPicker {...props()} allowHarnessChildren={false} />);
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Add subagent" })).not.toBeDisabled());
  fireEvent.click(screen.getByRole("combobox", { name: "Add subagent" }));
  expect(await screen.findByRole("option", { name: /Coding specialist/ })).toBeDisabled();
  expect(screen.getByRole("option", { name: /Network specialist/ })).toBeEnabled();
});

it.each(["claude_code_acp", "claude_code_cli_acp"])("selects a configured %s agent with an ACP label and its saved reference", async runtime => {
  global.fetch = jest.fn(async url => String(url).includes("remote-agents") ? response({ items: [] }) : response({ agents: [{ ...local, execution_harness_id: runtime }] })) as jest.Mock;
  const selection = props();
  render(<DelegatedAgentsPicker {...selection} />);
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Add subagent" })).toBeEnabled());
  fireEvent.click(screen.getByRole("combobox", { name: "Add subagent" }));
  fireEvent.click(await screen.findByRole("option", { name: /Coding specialist.*ACP/ }));
  expect(selection.onChange).toHaveBeenCalledWith([expect.objectContaining({ agent_id: "same-id" })]);
  expect(selection.remote.onChange).not.toHaveBeenCalled();
});
