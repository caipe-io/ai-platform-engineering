import { render, screen, within } from "@testing-library/react";
import type { UnifiedAuditEvent } from "@/lib/rbac/types";
import { AccessDecisionChain } from "../AccessDecisionChain";

const event: UnifiedAuditEvent = {
  ts: "2026-10-14T12:00:00Z", type: "cas_decision", tenant_id: "default", action: "call", outcome: "deny",
  correlation_id: "request-1", source: "cas", subject_ref: "service_account:test-service",
  actor_ref: "workload:agentgateway", agent_ref: "agent:example", resource_ref: "tool:example/list",
  failed_gate: "caller_tool", gateway_policy: "Agent AND caller need tool access; exact OR server-wide grants may match.",
  gateway_checks: [
    { gate: "context", subject_ref: "service_account:test-service", decision: "ALLOW", reason: "OK" },
    { gate: "agent_tool", subject_ref: "agent:example", relation: "can_call", resource_ref: "tool:example/list", decision: "ALLOW", reason: "OK" },
    { gate: "caller_tool", subject_ref: "service_account:test-service", relation: "can_call", resource_ref: "tool:example/list", decision: "DENY", reason: "NO_CAPABILITY" },
    { gate: "caller_tool", subject_ref: "service_account:test-service", relation: "can_call", resource_ref: "tool:example/*", decision: "DENY", reason: "NO_CAPABILITY" },
  ],
};

it("shows the starting entity, captured rule and ordered checks without inventing a grant path", () => {
  render(<AccessDecisionChain event={event} />);
  expect(screen.getByText(/Starting principal:/).closest("p")).toHaveTextContent("service_account:test-service → agent:example → tool:example/list");
  expect(screen.getByText(/Requested by:/).closest("p")).toHaveTextContent("workload:agentgateway");
  expect(screen.getByText(/Rule at the time:/).closest("p")).toHaveTextContent(event.gateway_policy!);
  const steps = within(screen.getByRole("list")).getAllByRole("listitem");
  expect(steps).toHaveLength(4);
  expect(steps[1]).toHaveTextContent("agent:example · can_call · tool:example/list");
  expect(steps[1]).toHaveClass("bg-green-500/10", "text-foreground");
  expect(steps[2]).toHaveTextContent("No match");
  expect(steps[2]).toHaveClass("bg-muted/30");
  expect(steps[3]).toHaveTextContent("tool:example/*");
  expect(steps[3]).toHaveTextContent("Denied");
  expect(steps[3]).toHaveClass("bg-red-500/10", "text-foreground");
  expect(screen.getByText(/Stopped at Caller/)).toBeInTheDocument();
  expect(screen.getByText(/does not identify the particular team/)).toBeInTheDocument();
});

it("does not confuse an exact no-match with a final denial when wildcard passes", () => {
  const checks = event.gateway_checks!.map((check, index) => index === 3 ? { ...check, decision: "ALLOW" as const, reason: "OK" as const } : check);
  render(<AccessDecisionChain event={{ ...event, outcome: "allow", failed_gate: undefined, gateway_checks: checks }} />);
  expect(screen.getByText("All required checks passed.")).toBeInTheDocument();
  expect(screen.getByText(/alternatives.*not the final request verdict/)).toBeInTheDocument();
  const steps = within(screen.getByRole("list")).getAllByRole("listitem");
  expect(steps[2]).toHaveTextContent("No match");
  expect(steps[2]).not.toHaveClass("bg-red-500/10");
  expect(steps[3]).toHaveTextContent("Passed");
  expect(steps[3]).toHaveClass("bg-green-500/10");
});

it("distinguishes principal, relation and resource roles without treating colour as a verdict", () => {
  render(<AccessDecisionChain event={event} />);
  const steps = within(screen.getByRole("list")).getAllByRole("listitem");
  expect(within(steps[1]).getByLabelText("Principal: agent:example")).toHaveClass("bg-violet-500/15", "font-semibold");
  expect(within(steps[1]).getByLabelText("Action / relation: can_call")).toHaveClass("bg-muted/50");
  expect(within(steps[1]).getByLabelText("Resource: tool:example/list")).toHaveClass("bg-cyan-500/10");
  expect(within(steps[3]).getByLabelText("Principal: service_account:test-service")).toHaveClass("bg-violet-500/15");
  expect(screen.getByLabelText("Resource: agent:example")).toHaveClass("bg-cyan-500/10");
});

it("marks an unavailable check amber rather than presenting it as a permission denial", () => {
  const checks = event.gateway_checks!.slice(0, 3).map((check, index) => index === 2 ? { ...check, reason: "AUTHZ_UNAVAILABLE" as const } : check);
  render(<AccessDecisionChain event={{ ...event, reason_code: "AUTHZ_UNAVAILABLE", gateway_checks: checks }} />);
  const step = screen.getByText("Unavailable").closest("li");
  expect(step).toHaveClass("bg-amber-500/10", "text-foreground");
  expect(step).not.toHaveClass("bg-red-500/10");
});

it("marks context rejection red with an explicit text label", () => {
  render(<AccessDecisionChain event={{ ...event, failed_gate: "context", gateway_checks: [{ gate: "context", subject_ref: event.subject_ref!, decision: "DENY", reason: "NO_CAPABILITY" }] }} />);
  expect(screen.getByText("Rejected").closest("li")).toHaveClass("bg-red-500/10", "text-foreground");
});

it("does not present a sample chain as evidence for an aggregate, even count one", () => {
  render(<AccessDecisionChain event={{ ...event, count: 1 }} />);
  expect(screen.getByText(/No individual chain is available/)).toBeInTheDocument();
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
});

it("states when the full sequence is absent", () => {
  render(<AccessDecisionChain event={{ ...event, gateway_checks: undefined }} />);
  expect(screen.getByText(/Full check sequence not recorded/)).toBeInTheDocument();
});
