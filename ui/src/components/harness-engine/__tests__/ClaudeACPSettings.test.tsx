import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ClaudeACPSettings, ClaudeSandboxSetup } from "../ClaudeACPSettings";
import type { HarnessDescriptor } from "@/types/harness-engine";

const descriptor: HarnessDescriptor = {
  id: "claude_code_acp", display_name: "Claude (ACP)", adapter_version: "1", contract_version: 2,
  execution_mode: "remote_worker", availability: "available", certification: "experimental",
  profiles: [{ id: "primary", harness_id: "claude_code_acp", display_name: "Primary", description: "", available: true,
    sandbox: { instance_id: "sandbox-1", display_name: "Private coding environment", portal_url: "https://sandbox.example.test/environments/1",
      policy_revision: "approved-1", policy_summary: "Private files; approved network destinations", status: "configured" } }],
  options_schema: { type: "object" }, ui_schema: { sandbox_portal_url: "https://sandbox.example.test" },
  capabilities: { "tools.broker": { level: "emulated", explanation: "", constraints: {} } },
};

it("shows the selected sandbox, honest connection state and separate management flow", () => {
  render(<ClaudeACPSettings descriptor={descriptor} profileId="primary" />);
  expect(screen.getByRole("region", { name: "Sandbox connection" })).toHaveTextContent("Configured");
  expect(screen.getByText(/checked when execution starts/)).toBeInTheDocument();
  expect(screen.getByText("Profile revision: approved-1")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Manage sandbox/ })).toHaveAttribute("href", "https://sandbox.example.test/environments/1");
  fireEvent.click(screen.getByText("Set up a sandboxed Claude agent"));
  expect(screen.getByRole("link", { name: "Open the sandbox application" })).toHaveAttribute("href", "https://sandbox.example.test/");
  expect(screen.getByText(/Creating the sandbox alone does not connect it/)).toBeInTheDocument();
  expect(screen.getByText(/Platform administrators manage/)).toBeInTheDocument();
  fireEvent.click(screen.getByText("Access and authentication"));
  expect(screen.getByText(/Deleting this chat does not delete/)).toBeInTheDocument();
});

it("does not borrow another profile's connection metadata", () => {
  render(<ClaudeACPSettings descriptor={descriptor} profileId="missing" />);
  expect(screen.queryByRole("region", { name: "Sandbox connection" })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /Manage sandbox/ })).not.toBeInTheDocument();
  expect(screen.getByText("Set up a sandboxed Claude agent").closest("details")).toHaveAttribute("open");
});

it("explains pending operator registration after a successful empty refresh", async () => {
  const refresh = jest.fn().mockResolvedValue(0);
  render(<ClaudeSandboxSetup portalUrl="https://sandbox.example.test" onRefresh={refresh} />);
  fireEvent.click(screen.getByRole("button", { name: "Refresh sandbox connections" }));
  expect(await screen.findByRole("status")).toHaveTextContent("No sandbox connection is registered for your account yet");
  expect(refresh).toHaveBeenCalledTimes(1);
});

it("shows a recoverable refresh error without requiring credentials in the browser", async () => {
  const refresh = jest.fn().mockRejectedValue(new Error("Unavailable"));
  render(<ClaudeSandboxSetup portalUrl="javascript:alert(1)" onRefresh={refresh} />);
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Refresh sandbox connections" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Connections could not be refreshed"));
  expect(screen.getByRole("button", { name: "Refresh sandbox connections" })).toBeEnabled();
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
});
