import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RemoteAgentsTab } from "../RemoteAgentsTab";

const mockToast = jest.fn();
const mockPush = jest.fn();
const mockCreateConversation = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock("@/store/chat-store", () => ({ useChatStore: (selector: (state: unknown) => unknown) => selector({ createConversation: mockCreateConversation }) }));
beforeEach(() => { jest.clearAllMocks(); mockCreateConversation.mockResolvedValue("conversation-example"); });
jest.mock("@/components/ui/toast", () => ({ useToast: () => ({ toast: mockToast }) }));
const response = (data: unknown) => ({ ok: true, json: async () => ({ success: true, data }) });

it("reviews a public discovery result and registers it without sending a JWT or selecting it for another agent", async () => {
  const fetcher = jest.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/dynamic-agents/available-subagents?create=true") return response({ agents: [] });
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
  global.fetch = jest.fn(async url => String(url).includes("available-subagents") ? response({ agents: [] }) : response({ items: [{ _id: "example", name: "Example", timeout_seconds: 120 }], can_manage_registry: false })) as unknown as typeof fetch;
  render(<RemoteAgentsTab />);
  await screen.findByText("Example");
  expect(screen.queryByLabelText("Discover remote agents")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Register agent" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Edit Example" })).not.toBeInTheDocument();
});

const acpAgents = [
  { id: "same-id", name: "Code specialist", execution_harness_id: "claude_code_cli_acp" },
  { id: "sdk", name: "SDK specialist", execution_harness_id: "claude_code_acp" },
];
const registeredA2a = { _id: "same-id", name: "Network specialist", timeout_seconds: 120 };
function catalogFetch(agents = acpAgents) {
  return jest.fn(async (url: RequestInfo | URL) => String(url).includes("available-subagents")
    ? response({ agents }) : response({ items: [registeredA2a], can_manage_registry: false }));
}

it("unifies authorized A2A and both ACP runtimes without duplicating their registrations", async () => {
  const fetcher = catalogFetch([...acpAgents,
    { id: "native", name: "Native specialist", execution_harness_id: "dynamic_agents" },
    { id: "unsupported", name: "Unsupported specialist", execution_harness_id: "unknown" },
  ]);
  global.fetch = fetcher as typeof fetch;
  render(<RemoteAgentsTab />);
  const code = await screen.findByRole("article", { name: "Code specialist ACP agent" });
  expect(await screen.findByRole("article", { name: "SDK specialist ACP agent" })).toBeInTheDocument();
  const catalog = screen.getByLabelText("Remote agent catalog");
  expect(within(catalog).getByText("Network specialist")).toBeInTheDocument();
  expect(within(catalog).queryByText("Native specialist")).not.toBeInTheDocument();
  expect(within(catalog).queryByText("Unsupported specialist")).not.toBeInTheDocument();
  expect(within(code).getByRole("link", { name: "Open agent" })).toHaveAttribute("href", "/dynamic-agents?tab=agents&agent=same-id");
  expect(within(code).queryByRole("button", { name: /Read Agent Card|Remove|Edit/ })).not.toBeInTheDocument();
  expect(fetcher.mock.calls).toHaveLength(2);
  fireEvent.change(screen.getByRole("textbox", { name: "Search remote agents" }), { target: { value: "ACP" } });
  expect(within(catalog).queryByText("Network specialist")).not.toBeInTheDocument();
  expect(within(catalog).getByText("Code specialist")).toBeInTheDocument();
});

it("starts an ACP chat with the existing agent ID and no registration or profile writes", async () => {
  global.fetch = catalogFetch() as typeof fetch;
  render(<RemoteAgentsTab />);
  const chat = await screen.findByRole("button", { name: "Chat with Code specialist" });
  fireEvent.click(chat);
  fireEvent.click(chat);
  await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/chat/conversation-example"));
  expect(mockCreateConversation).toHaveBeenCalledTimes(1);
  expect(mockCreateConversation).toHaveBeenCalledWith("same-id");
  expect((global.fetch as jest.Mock).mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
});

it("reports an ACP chat denial without navigating or switching identities", async () => {
  global.fetch = catalogFetch() as typeof fetch;
  mockCreateConversation.mockRejectedValue(new Error("Denied"));
  render(<RemoteAgentsTab />);
  fireEvent.click(await screen.findByRole("button", { name: "Chat with Code specialist" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not start this chat");
  expect(mockPush).not.toHaveBeenCalled();
  expect(mockCreateConversation).toHaveBeenCalledTimes(1);
});

it.each(["a2a", "acp"])("keeps the other catalog usable when %s fails", async source => {
  global.fetch = jest.fn(async url => {
    const isAcp = String(url).includes("available-subagents");
    if (isAcp === (source === "acp")) throw new Error("Unavailable");
    return isAcp ? response({ agents: acpAgents }) : response({ items: [registeredA2a], can_manage_registry: false });
  }) as typeof fetch;
  render(<RemoteAgentsTab />);
  await screen.findByRole("alert");
  if (source === "a2a") expect(await screen.findByRole("button", { name: "Chat with Code specialist" })).toBeEnabled();
  else expect(await screen.findByText("Network specialist")).toBeInTheDocument();
});

it("removes revoked ACP choices after refresh without modifying any agent", async () => {
  let agents = acpAgents;
  global.fetch = jest.fn(async url => String(url).includes("available-subagents")
    ? response({ agents }) : response({ items: [], can_manage_registry: false })) as typeof fetch;
  render(<RemoteAgentsTab />);
  await screen.findByRole("button", { name: "Chat with Code specialist" });
  await waitFor(() => expect(screen.getByRole("button", { name: "Refresh agents" })).toBeEnabled());
  agents = [];
  fireEvent.click(screen.getByRole("button", { name: "Refresh agents" }));
  await screen.findByText("No A2A or configured ACP agents are available.");
  expect(screen.queryByRole("button", { name: "Chat with Code specialist" })).not.toBeInTheDocument();
});
