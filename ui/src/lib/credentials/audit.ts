import { redactCredentialDetails } from "./masking";
import { getAuditClient } from "@/lib/audit";
import { createHash, randomUUID } from "crypto";

export type CredentialAuditResult = "denied" | "failure" | "success";

export interface CredentialAuditActor {
  type: "service" | "system" | "user";
  id: string;
}

export interface CredentialAuditResource {
  type: "provider_connection" | "secret_ref";
  id: string;
}

export interface CredentialAuditEventInput {
  action: string;
  actor: CredentialAuditActor;
  resource: CredentialAuditResource;
  result: CredentialAuditResult;
  details?: Record<string, unknown>;
  correlationId?: string;
}

const SUBJECT_SALT = process.env.AUDIT_SUBJECT_SALT ?? "caipe-098-audit";

function hashSubject(id: string): string {
  return "sha256:" + createHash("sha256").update(`${SUBJECT_SALT}:${id}`).digest("hex");
}

export function writeCredentialAuditEvent(
  input: CredentialAuditEventInput,
): void {
  const outcome = input.result === "denied" ? "deny" : input.result === "failure" ? "error" : "success";
  getAuditClient().append({
    audit_event_id: randomUUID(),
    type: "credential_action",
    ts: new Date().toISOString(),
    action: input.action,
    component: "credential_vault",
    source: "webui_backend",
    tenant_id: process.env.TENANT_ID ?? "default",
    subject_hash: hashSubject(input.actor.id),
    outcome,
    correlation_id: input.correlationId ?? randomUUID(),
    resource_ref: `${input.resource.type}:${input.resource.id}`,
    actor: input.actor,
    resource: input.resource,
    result: input.result,
    details: input.details ? redactCredentialDetails(input.details) : {},
  });
}
