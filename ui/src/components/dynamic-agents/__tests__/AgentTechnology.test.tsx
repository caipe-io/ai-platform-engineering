import { render, screen } from "@testing-library/react";
import { AgentTechnologyIcon, AgentProtocolBadge } from "../AgentTechnology";

it.each([
  ["claude_code", "Claude Code", "claude.svg"],
  ["claude_agent_sdk", "Claude Agent SDK", "claude.svg"],
  ["google_adk", "Google ADK", "adk.svg"],
  ["deepagents", "LangChain Deep Agents", "deepagents.svg"],
])("identifies an explicitly declared %s framework independently from A2A", (framework, label, asset) => {
  render(<><AgentTechnologyIcon protocol="a2a" framework={framework} /><AgentProtocolBadge protocol="a2a" /></>);
  expect(screen.getByRole("img", { name: `${framework === "google_adk" ? "Agent framework" : "Execution harness"}: ${label}` }).querySelector("img")).toHaveAttribute("src", `/provider-logos/${asset}`);
  expect(screen.getByText("A2A")).toBeInTheDocument();
});

it("does not infer a framework from the A2A protocol", () => {
  render(<AgentTechnologyIcon protocol="a2a" />);
  expect(screen.getByRole("img", { name: "Remote agent: A2A" }).querySelector("img")).toHaveAttribute("src", "/provider-logos/a2a.svg");
  expect(screen.queryByRole("img", { name: /ADK|Deep Agents/ })).not.toBeInTheDocument();
});

it("keeps the saved ACP runtime authoritative over display metadata", () => {
  render(<AgentTechnologyIcon protocol="acp" harnessId="claude_code_cli_acp" framework="google_adk" />);
  expect(screen.getByRole("img", { name: "Execution harness: Claude Code" }).querySelector("img")).toHaveAttribute("src", "/provider-logos/claude.svg");
  expect(screen.queryByRole("img", { name: "Google ADK" })).not.toBeInTheDocument();
});
