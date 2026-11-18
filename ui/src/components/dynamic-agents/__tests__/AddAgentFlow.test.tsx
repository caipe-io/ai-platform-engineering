import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RemoteAgentRegistry } from "../RemoteAgentRegistry";

const mockToast = jest.fn();
jest.mock("@/components/ui/toast", () => ({ useToast: () => ({ toast: mockToast }) }));

function response(data: unknown) {
  return { ok: true, json: async () => ({ success: true, data }) };
}

function setup(canManage = true) {
  const onCreate = jest.fn();
  const onRegistryChange = jest.fn();
  const fetcher = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/discovery")) {
      return response(init?.method === "POST" ? { items: [{
        endpoint: "https://agent.example.test",
        name: "Example agent",
        description: "Example description",
        supports_streaming: true,
        protocol_version: "1.0",
        protocol_bindings: ["JSONRPC"],
      }] } : { namespaces: ["primary"] });
    }
    if (url === "/api/remote-agents") {
      return response(init?.method === "POST"
        ? { _id: "example-agent", ...JSON.parse(init.body as string) }
        : { items: [], can_manage_registry: canManage });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  global.fetch = fetcher as typeof fetch;
  render(<RemoteAgentRegistry onCreateAgent={onCreate} onRegistryChange={onRegistryChange}
    renderCatalog={({ toolbar }) => <div>{toolbar}</div>} />);
  return { fetcher, onCreate, onRegistryChange };
}

it("opens Agent Builder only after choosing creation, without making registry writes", async () => {
  const { fetcher, onCreate } = setup();
  fireEvent.click(screen.getByRole("button", { name: "Add agent", exact: true }));
  expect(onCreate).not.toHaveBeenCalled();
  const dialog = screen.getByRole("dialog", { name: "Add agent", exact: true });
  fireEvent.click(within(dialog).getByRole("button", { name: /^Create CAIPE agent/ }));
  expect(onCreate).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(fetcher.mock.calls.every(([, init]) => !init?.method)).toBe(true);
});

it.each(["urls", "kubernetes"])("discovers with %s and preserves connection configuration before an explicit save", async source => {
  const { fetcher, onCreate, onRegistryChange } = setup();
  const trigger = screen.getByRole("button", { name: "Add agent", exact: true });
  fireEvent.click(trigger);
  const connect = screen.getByRole("button", { name: /^Connect existing agent/ });
  await waitFor(() => expect(connect).toBeEnabled());
  fireEvent.click(connect);
  expect(onCreate).not.toHaveBeenCalled();
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Connect agent", exact: true })).not.toBeInTheDocument();
  if (source === "urls") {
    fireEvent.change(screen.getByLabelText("Agent URLs or Agent Card URLs"), {
      target: { value: "https://agent.example.test\nhttps://secondary.example.test/.well-known/agent-card.json" },
    });
  } else {
    fireEvent.change(screen.getByLabelText("Discovery source"), { target: { value: "kubernetes" } });
    fireEvent.click(screen.getByRole("combobox", { name: "Discovery namespace" }));
    fireEvent.click(await screen.findByRole("option", { name: "primary", exact: true }));
  }
  fireEvent.click(screen.getByRole("button", { name: "Discover", exact: true }));
  fireEvent.click(await screen.findByRole("button", { name: "Review", exact: true }));
  expect(screen.getByLabelText("Name")).toHaveValue("Example agent");
  expect(screen.getByLabelText("Description")).toHaveValue("Example description");
  expect(screen.getByLabelText("Credential source")).toHaveValue("none");
  expect(screen.getByLabelText("Header name")).toBeDisabled();
  expect(fetcher.mock.calls.filter(([url, init]) => String(url) === "/api/remote-agents" && init?.method === "POST")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Back to discovery", exact: true }));
  expect(screen.getByLabelText("Discovery source")).toHaveValue(source);
  fireEvent.click(screen.getByRole("button", { name: "Review", exact: true }));
  fireEvent.click(screen.getByText("Advanced settings", { selector: "summary" }));
  expect(screen.getByRole("checkbox", { name: "Stream responses" })).toBeChecked();
  fireEvent.change(screen.getByLabelText("Timeout (seconds, 1–600)"), { target: { value: "45" } });
  fireEvent.change(screen.getByLabelText("Framework"), { target: { value: "google_adk" } });
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Reviewed description" } });
  fireEvent.click(screen.getByRole("button", { name: "Connect agent", exact: true }));
  await waitFor(() => expect(onRegistryChange).toHaveBeenCalledTimes(1));
  const discovery = fetcher.mock.calls.find(([url, init]) => String(url).endsWith("/discovery") && init?.method === "POST")!;
  expect(JSON.parse(discovery[1]!.body as string)).toEqual(source === "urls"
    ? { source, urls: ["https://agent.example.test", "https://secondary.example.test/.well-known/agent-card.json"] }
    : { source, namespace: "primary" });
  const writes = fetcher.mock.calls.filter(([url, init]) => String(url) === "/api/remote-agents" && init?.method === "POST");
  expect(writes).toHaveLength(1);
  expect(JSON.parse(writes[0][1]!.body as string)).toEqual({
    name: "Example agent", endpoint: "https://agent.example.test", description: "Reviewed description",
    framework: "google_adk", timeout_seconds: 45, streaming: true,
    credential_source: { kind: "none", target: "header", name: "Authorization" },
    protocol_version: "1.0", protocol_bindings: ["JSONRPC"], supports_streaming: true,
  });
  await waitFor(() => expect(trigger).toHaveFocus());
});

it("keeps creation available to registry readers and explains the disabled connection option", async () => {
  const { fetcher, onCreate } = setup(false);
  await waitFor(() => expect(fetcher).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: "Add agent", exact: true }));
  expect(screen.getByRole("button", { name: /^Connect existing agent/ })).toBeDisabled();
  expect(screen.getByText(/Registry management access is required/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /^Create CAIPE agent/ }));
  expect(onCreate).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/discovery"))).toBe(false);
});
