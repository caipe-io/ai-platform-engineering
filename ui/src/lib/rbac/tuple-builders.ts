import type {
UniversalRebacRelationship,
UniversalRebacResourceAction,
UniversalRebacResourceRef,
UniversalRebacSubjectRef,
} from "@/types/rbac-universal";

import type { OpenFgaTupleKey,TeamResourceTupleDiff } from "./openfga";
import { openFgaResourceObject } from "./openfga-resource-ids";
import { assertRelationshipValid } from "./relationship-validator";

const ACTION_TO_BASE_RELATION: Record<UniversalRebacResourceAction, string> = {
  discover: "reader",
  read: "reader",
  use: "user",
  write: "writer",
  create: "owner",
  delete: "manager",
  manage: "manager",
  administer: "manager",
  audit: "auditor",
  approve: "approver",
  share: "sharer",
  call: "caller",
  invoke: "invoker",
  map: "manager",
  ingest: "ingestor",
  "read-metadata": "metadata_reader",
  automate: "automation_eligible",
};

const ACTION_TO_CHECK_RELATION: Record<UniversalRebacResourceAction, string> = {
  discover: "can_discover",
  read: "can_read",
  use: "can_use",
  write: "can_write",
  create: "can_manage",
  delete: "can_delete",
  manage: "can_manage",
  administer: "can_admin",
  audit: "can_audit",
  approve: "can_approve",
  share: "can_share",
  call: "can_call",
  invoke: "can_invoke",
  map: "can_map",
  ingest: "can_ingest",
  "read-metadata": "can_read_metadata",
  automate: "can_automate",
};

export const OPENFGA_ACTION_RELATIONS = Array.from(
  new Set([...Object.values(ACTION_TO_BASE_RELATION), ...Object.values(ACTION_TO_CHECK_RELATION)])
);

export interface UniversalRebacTupleDiffInput {
  writes: UniversalRebacRelationship[];
  deletes: UniversalRebacRelationship[];
}

export function openFgaSubject(subject: UniversalRebacSubjectRef): string {
  const base = `${subject.type}:${subject.id}`;
  return subject.relation ? `${base}#${subject.relation}` : base;
}

export function openFgaObject(resource: UniversalRebacResourceRef): string {
  return openFgaResourceObject(resource.type, resource.id);
}

export function openFgaRelation(action: UniversalRebacResourceAction): string {
  return ACTION_TO_BASE_RELATION[action];
}

export function openFgaCheckRelation(action: UniversalRebacResourceAction): string {
  return ACTION_TO_CHECK_RELATION[action];
}

export function buildOpenFgaTuple(relationship: UniversalRebacRelationship): OpenFgaTupleKey {
  assertRelationshipValid(relationship);
  return {
    user: openFgaSubject(relationship.subject),
    relation: openFgaRelation(relationship.action),
    object: openFgaObject(relationship.resource),
  };
}

function uniqueTuples(tuples: OpenFgaTupleKey[]): OpenFgaTupleKey[] {
  const seen = new Set<string>();
  const out: OpenFgaTupleKey[] = [];
  for (const tuple of tuples) {
    const key = `${tuple.user}\n${tuple.relation}\n${tuple.object}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tuple);
  }
  return out;
}

export function buildOpenFgaTupleDiff(input: UniversalRebacTupleDiffInput): TeamResourceTupleDiff {
  return {
    writes: uniqueTuples(input.writes.map(buildOpenFgaTuple)),
    deletes: uniqueTuples(input.deletes.map(buildOpenFgaTuple)),
  };
}

export const buildUniversalRebacTupleDiff = buildOpenFgaTupleDiff;
