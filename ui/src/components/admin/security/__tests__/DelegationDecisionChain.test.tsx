import { render, screen } from "@testing-library/react";
import type { UnifiedAuditEvent } from "@/lib/rbac/types";
import { AccessDecisionChain } from "../AccessDecisionChain";
import { describeAccessDecision } from "../access-decision-description";
const event: UnifiedAuditEvent = {
  ts: "2026-10-21T12:00:00Z", type: "cas_decision", tenant_id: "primary", source: "cas", action: "use", outcome: "deny",
  correlation_id: "request-1", decision_id: "decision-1", delegation_id: "approval-1", delegation_policy: "cas-delegation/v1",
  actor_ref: "service_account:test-service", subject_ref: "user:test-user", resource_ref: "agent:example", reason_code: "USER_NOT_ALLOWED",
  delegation_evidence: { kind: "cas_approval", reference: "approval-1" },
  delegation: { user_ref: "user:test-user", service_ref: "service_account:test-service", issuer: "https://identity.example.test",
    service: { id: "test-service", client_id: "example-service" }, job_id: "test-job", version: 1,
    created_at: "2026-10-21T11:00:00Z", expires_at: "2026-10-22T11:00:00Z", revoked_at: null,
    scope: [{ resource: { type: "agent", id: "example" }, action: "use" }] },
  delegation_checks: [{ gate: "binding", decision: "ALLOW", reason: "OK" },
    { gate: "user_permission", decision: "DENY", reason: "USER_NOT_ALLOWED" }],
};
it("shows actor, effective user, approval scope/lifetime and the recorded failed check", () => {
  render(<AccessDecisionChain event={event} />);
  expect(screen.getByRole("region", { name: "Recorded delegation chain" })).toBeInTheDocument();
  expect(screen.getByText(/Acting principal:/).closest("p")).toHaveTextContent("service_account:test-service → on behalf of user:test-user → agent:example");
  expect(screen.getByText(/Approval: approval-1/)).toHaveTextContent("version 1");
  expect(screen.getByText(/Authority evidence:/)).toHaveTextContent("CAS job approval · approval-1");
  expect(screen.getByText(/Approved at:/)).toHaveTextContent("expires: 2026-10-22T11:00:00Z");
  expect(screen.getByRole("list", { name: "Approved scope" })).toHaveTextContent("use agent:example");
  expect(screen.getByText(/User still has access/)).toHaveClass("bg-red-500/10");
  expect(screen.getByText(/Service, issuer/)).toHaveClass("bg-green-500/10");
  expect(screen.getByText(/application-supplied label/)).toBeInTheDocument();
  expect(screen.getByText(/not proof that downstream work executed/)).toBeInTheDocument();
  expect(describeAccessDecision(event)).toMatchObject({ label: "Delegation denied", explanation: "The user did not have the required permission." });
});
it("does not fabricate the owner/approval chain for an unmatched reference", () => {
  render(<AccessDecisionChain event={{ ...event, delegation: undefined, reason_code: "DELEGATION_BINDING_MISMATCH" }} />);
  expect(screen.getByText(/no matching approval verified/)).toBeInTheDocument();
  expect(screen.queryByText(/on behalf of/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Authority evidence:/)).not.toBeInTheDocument();
});
