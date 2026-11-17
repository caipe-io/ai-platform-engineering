import { render, screen } from "@testing-library/react";
import { AgentIdentity } from "../AgentIdentity";
import { AgentCatalogCard } from "../AgentCatalogCard";

it.each([
  ["claude_agent_sdk", "Claude Agent SDK", "claude.svg"],
  ["claude_agent_sdk_remote", "Claude Agent SDK", "claude.svg"],
  ["claude_code_cli_acp", "Claude Code", "claude.svg"],
  ["dynamic_agents", "LangChain Deep Agents", "deepagents.svg"],
  ["agentcore", "Amazon Bedrock AgentCore", "agentcore.svg"],
])("keeps the configured %s badge even over an A2A connection", (harnessId, label, asset) => {
  render(<AgentIdentity agent={{ _id: "example-agent", ui: { gradient_theme: "ocean" } }} harnessId={harnessId} protocol="a2a" framework="google_adk" />);
  const badge = screen.getByRole("img", { name: `Execution harness: ${label}` });
  expect(badge.querySelector("img")).toHaveAttribute("src", `/provider-logos/${asset}`);
  expect(document.querySelector('[data-agent-theme="ocean"]')).toBeInTheDocument();
  expect(screen.queryByRole("img", { name: "Remote agent: A2A" })).not.toBeInTheDocument();
});

it("uses declared remote framework metadata before the A2A fallback", () => {
  render(<AgentIdentity protocol="a2a" framework="claude_agent_sdk" />);
  expect(screen.getByRole("img", { name: "Execution harness: Claude Agent SDK" }).querySelector("img")).toHaveAttribute("src", "/provider-logos/claude.svg");
});

it("uses A2A for an unknown remote harness without inferring Deep Agents", () => {
  render(<AgentIdentity harnessId="unrecognized" protocol="a2a" />);
  expect(screen.getByRole("img", { name: "Remote agent: A2A" }).querySelector("img")).toHaveAttribute("src", "/provider-logos/a2a.svg");
  expect(screen.queryByLabelText(/Deep Agents/)).not.toBeInTheDocument();
});

it("keeps the legacy native default when no remote protocol is present", () => {
  render(<AgentIdentity />);
  expect(screen.getByRole("img", { name: "Execution harness: LangChain Deep Agents" })).toBeInTheDocument();
});

it("uses the same saved theme for the soft header and avatar", () => {
  const agent = { _id: "example-agent", ui: { gradient_theme: "ocean" } };
  const { container } = render(<AgentCatalogCard name="Example" agent={agent} identity={<AgentIdentity agent={agent} />} footer={null}>Example details</AgentCatalogCard>);
  const avatar = container.querySelector('[data-agent-theme="ocean"]') as HTMLElement;
  const wash = container.querySelector('header [aria-hidden="true"]') as HTMLElement;
  expect(wash.style.background).toBe(avatar.style.background);
  expect(wash).toHaveClass("opacity-[0.08]");
});
