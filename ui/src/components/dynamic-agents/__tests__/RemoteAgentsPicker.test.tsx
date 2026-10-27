import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockToast = jest.fn();
jest.mock("@/components/ui/toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

import { RemoteAgentsPicker } from "../RemoteAgentsPicker";

function jsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ success: true, data }),
  };
}

describe("RemoteAgentsPicker", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("registers and selects a remote agent without submitting its parent agent form", async () => {
    const onChange = jest.fn();
    const onParentSubmit = jest.fn((event: React.FormEvent) => event.preventDefault());
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "/api/remote-agents") {
        if (init?.method === "POST") {
          return jsonResponse({
            _id: "remote-example-agent",
            name: "Example Agent",
            description: "Network diagnostics.",
            endpoint: "https://agent.example.test/",
            timeout_seconds: 120,
            enabled: true,
          }, 201);
        }
        return jsonResponse({ items: [], can_manage_registry: true });
      }
      if (url === "/api/remote-agents/probe") {
        return jsonResponse({
          name: "Example Agent",
          description: "Network diagnostics.",
          protocol_version: "1.0",
          protocol_bindings: ["JSONRPC"],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    global.fetch = fetchMock;

    const { container } = render(
      <form onSubmit={onParentSubmit}>
        <RemoteAgentsPicker
          value={[]}
          onChange={onChange}
          timeoutValues={{}}
          onTimeoutChange={jest.fn()}
        />
      </form>,
    );

    await screen.findByText("No remote A2A agents are registered.");
    expect(container.querySelectorAll("form")).toHaveLength(1);

    fireEvent.change(screen.getByLabelText("Agent URL"), {
      target: { value: "https://agent.example.test/" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Discover Agent Card" }));

    expect(await screen.findByDisplayValue("Example Agent")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Stream responses" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "Stream responses" }));
    fireEvent.click(screen.getByRole("button", { name: "Add and select" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/remote-agents",
        expect.objectContaining({ method: "POST" }),
      );
      expect(onChange).toHaveBeenCalledWith(["remote-example-agent"]);
    });
    const posted = fetchMock.mock.calls.find(([, init]) => init?.method === "POST" && JSON.parse(init.body as string).streaming === true);
    expect(posted).toBeDefined();
    expect(onParentSubmit).not.toHaveBeenCalled();
  });
  it.each(["secret_ref", "provider_connection"])("saves the selected %s authentication reference", async (kind) => {
    const onParentSubmit = jest.fn((event: React.FormEvent) => event.preventDefault());
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "/api/credentials/secrets") return jsonResponse([{ id: "secret-example", name: "Example secret" }]);
      if (url === "/api/credentials/oauth-connectors") return jsonResponse([{ provider: "example", name: "Example provider" }]);
      if (url === "/api/remote-agents/probe") return jsonResponse({ name: "Example Agent", description: "Example" });
      if (url === "/api/remote-agents") {
        if (init?.method === "POST") return jsonResponse({ _id: "remote-example", ...JSON.parse(init.body as string) });
        return jsonResponse({ items: [], can_manage_registry: true });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    global.fetch = fetchMock;
    render(<form onSubmit={onParentSubmit}><RemoteAgentsPicker value={[]} onChange={jest.fn()} timeoutValues={{}} onTimeoutChange={jest.fn()} /></form>);
    await screen.findByText("No remote A2A agents are registered.");
    fireEvent.change(screen.getByLabelText("Credential source"), { target: { value: kind } });
    fireEvent.change(screen.getByLabelText("Header name"), { target: { value: "X-Agent-Token" } });
    if (kind === "secret_ref") {
      fireEvent.click(screen.getByRole("combobox", { name: "Saved secret" }));
      fireEvent.click(await screen.findByRole("option", { name: "Example secret" }));
    } else {
      await screen.findByRole("option", { name: "Example provider" });
      fireEvent.change(screen.getByRole("combobox", { name: "Connected provider" }), { target: { value: "example" } });
    }
    fireEvent.change(screen.getByLabelText("Agent URL"), { target: { value: "https://agent.example.test/" } });
    fireEvent.click(screen.getByRole("button", { name: "Discover Agent Card" }));
    await screen.findByDisplayValue("Example Agent");
    fireEvent.click(screen.getByRole("button", { name: "Add and select" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/remote-agents", expect.objectContaining({ method: "POST" })));
    const source = { kind, target: "header", name: "X-Agent-Token", ...(kind === "secret_ref" ? { secret_ref: "secret-example" } : { provider: "example" }) };
    for (const [, init] of fetchMock.mock.calls) {
      if (init?.method === "POST") expect(JSON.parse(init.body as string).credential_source).toEqual(source);
    }
    expect(onParentSubmit).not.toHaveBeenCalled();
  });

  it.each(["POST", "PUT"])("ignores repeated Enter presses while a %s request is pending", async (method) => {
    let finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => { finish = resolve; });
    const item = { _id: "remote-example", name: "Example Agent", endpoint: "https://agent.example.test", timeout_seconds: 120 };
    const fetchMock = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === method) return pending;
      return jsonResponse({ items: method === "PUT" ? [item] : [], can_manage_registry: true });
    });
    global.fetch = fetchMock as typeof fetch;
    render(<RemoteAgentsPicker value={[]} onChange={jest.fn()} timeoutValues={{}} onTimeoutChange={jest.fn()} />);
    let input: HTMLElement;
    if (method === "PUT") {
      fireEvent.click(await screen.findByRole("button", { name: "Edit Example Agent" }));
      input = screen.getAllByLabelText("Name")[0];
    } else {
      await screen.findByText("No remote A2A agents are registered.");
      input = screen.getByLabelText("Name");
      fireEvent.change(input, { target: { value: item.name } });
      fireEvent.change(screen.getByLabelText("Agent URL"), { target: { value: item.endpoint } });
    }
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === method)).toHaveLength(1);
    finish(jsonResponse(item));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(method === "PUT" ? "Remote A2A agent updated" : "Remote A2A agent added", "success"));
  });

});
