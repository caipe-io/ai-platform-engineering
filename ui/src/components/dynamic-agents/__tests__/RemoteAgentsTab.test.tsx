import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RemoteAgentsTab } from "../RemoteAgentsTab";

const mockToast = jest.fn();
jest.mock("@/components/ui/toast", () => ({ useToast: () => ({ toast: mockToast }) }));
const response = (data: unknown) => ({ ok: true, json: async () => ({ success: true, data }) });

it("reviews a public discovery result and registers it without sending a JWT or selecting it for another agent", async () => {
  const fetcher = jest.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/remote-agents/discovery") return response(init?.method === "POST" ? { items: [{ endpoint: "https://example.test", name: "Example specialist", description: "Answers questions", protocol_bindings: ["JSONRPC"] }] } : { namespaces: ["primary"] });
    if (url === "/api/remote-agents/probe") return response({ name: "Example specialist", description: "Answers questions", protocol_bindings: ["JSONRPC"], agent_card: { name: "Example specialist", version: "1.0" } });
    if (url === "/api/remote-agents") return response(init?.method === "POST" ? { _id: "remote-example", ...JSON.parse(init.body as string) } : { items: [], can_manage_registry: true });
    throw new Error("Unexpected request " + url);
  });
  global.fetch = fetcher as unknown as typeof fetch;
  render(<RemoteAgentsTab />);
  fireEvent.change(await screen.findByLabelText("Agent URLs or Agent Card URLs"), { target: { value: "https://example.test" } });
  fireEvent.click(screen.getByRole("button", { name: "Discover", exact: true }));
  fireEvent.click(await screen.findByRole("button", { name: "Review", exact: true }));
  expect(screen.getByDisplayValue("Example specialist")).toBeInTheDocument();
  expect(screen.queryByRole("checkbox", { name: "Allow Example specialist" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Add and select" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Discover Agent Card" }));
  await screen.findByText("Agent Card", { selector: "summary" });
  fireEvent.click(screen.getByRole("button", { name: "Register agent" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/remote-agents", expect.objectContaining({ method: "POST" })));
  const writes = fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
  expect(JSON.parse(writes[0][1]!.body as string)).toEqual({ source: "urls", urls: ["https://example.test"] });
  for (const [url, init] of writes.slice(1)) {
    expect(["/api/remote-agents/probe", "/api/remote-agents"]).toContain(url);
    expect(JSON.parse(init!.body as string).credential_source.kind).toBe("none");
  }
});

it("does not expose discovery or write controls to registry readers", async () => {
  global.fetch = jest.fn(async () => response({ items: [{ _id: "example", name: "Example", timeout_seconds: 120 }], can_manage_registry: false })) as unknown as typeof fetch;
  render(<RemoteAgentsTab />);
  await screen.findByText("Example");
  expect(screen.queryByLabelText("Discover remote agents")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Register agent" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Edit Example" })).not.toBeInTheDocument();
});
