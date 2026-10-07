import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

jest.mock("@/components/ui/toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
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
            _id: "remote-netutils-agent",
            name: "Netutils Agent",
            description: "Network diagnostics.",
            endpoint: "http://netutils-agent:8120/",
            timeout_seconds: 120,
            enabled: true,
          }, 201);
        }
        return jsonResponse({ items: [], can_manage_registry: true });
      }
      if (url === "/api/remote-agents/probe") {
        return jsonResponse({
          name: "Netutils Agent",
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
      target: { value: "http://netutils-agent:8120/" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Discover Agent Card" }));

    expect(await screen.findByDisplayValue("Netutils Agent")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add and select" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/remote-agents",
        expect.objectContaining({ method: "POST" }),
      );
      expect(onChange).toHaveBeenCalledWith(["remote-netutils-agent"]);
    });
    expect(onParentSubmit).not.toHaveBeenCalled();
  });
});
