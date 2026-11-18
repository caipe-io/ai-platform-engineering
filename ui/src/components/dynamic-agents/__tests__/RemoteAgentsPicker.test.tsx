import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RemoteAgentsPicker } from "../RemoteAgentsPicker";

const mockToast = jest.fn();
jest.mock("@/components/ui/toast", () => ({ useToast: () => ({ toast: mockToast }) }));
const entry = { _id: "remote-example", name: "Example specialist", description: "Network diagnostics", timeout_seconds: 120, protocol_bindings: ["JSONRPC"], streaming: true };
const response = (items = [entry]) => ({ ok: true, json: async () => ({ success: true, data: { items, can_manage_registry: true } }) });
const props = () => ({ value: [] as string[], onChange: jest.fn(), timeoutValues: {}, onTimeoutChange: jest.fn() });

it("adds an existing registry entry without registration or authentication requests", async () => {
  const fetcher = jest.fn(async () => response());
  global.fetch = fetcher as typeof fetch;
  const selection = props();
  render(<form onSubmit={event => event.preventDefault()}><RemoteAgentsPicker {...selection} /></form>);
  const picker = await screen.findByRole("combobox", { name: "Add remote agent from registry" });
  await waitFor(() => expect(picker).not.toBeDisabled());
  fireEvent.click(picker);
  fireEvent.click(await screen.findByRole("option", { name: /Example specialist/ }));
  expect(selection.onChange).toHaveBeenCalledWith([entry._id]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledWith("/api/remote-agents", { credentials: "include" });
  expect(screen.queryByLabelText("Agent URL")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Credential source")).not.toBeInTheDocument();
  const registry = screen.getByRole("link", { name: "Open Remote Agents" });
  expect(registry).toHaveAttribute("href", "/dynamic-agents?tab=remote-agents");
  expect(registry).toHaveAttribute("target", "_blank");
});

it("updates a selected timeout and removes only its parent reference", async () => {
  global.fetch = jest.fn(async () => response()) as typeof fetch;
  const selection = { ...props(), value: [entry._id], timeoutValues: { [entry._id]: 45 } };
  const { rerender } = render(<RemoteAgentsPicker {...selection} />);
  await screen.findByText(entry.name);
  expect(screen.getByRole("spinbutton", { name: "Timeout (seconds)" })).toHaveValue(45);
  fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "60" } });
  expect(selection.onTimeoutChange).toHaveBeenCalledWith(entry._id, 60);
  rerender(<RemoteAgentsPicker {...selection} disabled />);
  expect(screen.getByRole("button", { name: /Remove Example specialist/ })).toBeDisabled();
  rerender(<RemoteAgentsPicker {...selection} />);
  fireEvent.click(screen.getByRole("button", { name: /Remove Example specialist/ }));
  expect(selection.onChange).toHaveBeenCalledWith([]);
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

it("refreshes newly registered agents without dropping unavailable saved selections", async () => {
  const fetcher = jest.fn().mockResolvedValueOnce(response([])).mockResolvedValueOnce(response());
  global.fetch = fetcher;
  const selection = { ...props(), value: ["remote-unavailable"] };
  render(<RemoteAgentsPicker {...selection} />);
  await screen.findByText(/This agent is unavailable/);
  expect(selection.onChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Refresh registry" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getByRole("combobox")).not.toBeDisabled());
  fireEvent.click(screen.getByRole("combobox"));
  fireEvent.click(await screen.findByRole("option", { name: /Example specialist/ }));
  expect(selection.onChange).toHaveBeenCalledWith(["remote-unavailable", entry._id]);
});

it("reports registry errors and retains the saved selection through retry", async () => {
  const fetcher = jest.fn().mockRejectedValueOnce(new Error("Registry unavailable")).mockResolvedValueOnce(response());
  global.fetch = fetcher;
  const selection = { ...props(), value: [entry._id] };
  render(<RemoteAgentsPicker {...selection} />);
  await screen.findByRole("alert");
  expect(selection.onChange).not.toHaveBeenCalled();
  expect(screen.queryByText(/This agent is unavailable/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Refresh registry" }));
  await screen.findByText(entry.name);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(selection.onChange).not.toHaveBeenCalled();
});
