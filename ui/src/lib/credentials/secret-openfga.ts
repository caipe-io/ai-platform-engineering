import {
isOpenFgaReconciliationEnabled,
readOpenFgaTuples,
writeOpenFgaTupleDiff,
type OpenFgaTupleKey,
} from "@/lib/rbac/openfga";
import type { CredentialOwnerRef } from "./types";

const OPENFGA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~@|*+=,/-]{0,191}$/;

function validId(value: string): boolean {
  return OPENFGA_ID_PATTERN.test(value);
}

function objectId(secretId: string): string {
  if (!validId(secretId)) {
    throw new Error(`Invalid secret_ref id: ${secretId}`);
  }
  return `secret_ref:${secretId}`;
}

function unique(tuples: OpenFgaTupleKey[]): OpenFgaTupleKey[] {
  const seen = new Set<string>();
  return tuples.filter((tuple) => {
    const key = `${tuple.user}:${tuple.relation}:${tuple.object}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function buildSecretRefOwnerTuples(input: {
  secretId: string;
  owner: CredentialOwnerRef;
  ownerSubject?: string | null;
}): OpenFgaTupleKey[] {
  const object = objectId(input.secretId);
  const tuples: OpenFgaTupleKey[] = [];

  if (input.owner.type === "user" && input.ownerSubject && validId(input.ownerSubject)) {
    tuples.push(
      { user: `user:${input.ownerSubject}`, relation: "metadata_reader", object },
      { user: `user:${input.ownerSubject}`, relation: "user", object },
      { user: `user:${input.ownerSubject}`, relation: "manager", object },
      { user: `user:${input.ownerSubject}`, relation: "auditor", object },
    );
  }

  if (input.owner.type === "team" && validId(input.owner.id)) {
    tuples.push(
      { user: `team:${input.owner.id}#member`, relation: "metadata_reader", object },
      { user: `team:${input.owner.id}#member`, relation: "user", object },
      { user: `team:${input.owner.id}#admin`, relation: "manager", object },
      { user: `team:${input.owner.id}#admin`, relation: "auditor", object },
    );
  }

  if (input.owner.type === "organization" && validId(input.owner.id)) {
    tuples.push(
      { user: `organization:${input.owner.id}#member`, relation: "metadata_reader", object },
      { user: `organization:${input.owner.id}#member`, relation: "user", object },
      { user: `organization:${input.owner.id}#admin`, relation: "manager", object },
      { user: `organization:${input.owner.id}#admin`, relation: "auditor", object },
    );
  }

  return unique(tuples);
}

export function buildSecretRefShareTuples(secretId: string, teamId: string): OpenFgaTupleKey[] {
  if (!validId(teamId)) {
    throw new Error(`Invalid team id: ${teamId}`);
  }
  const object = objectId(secretId);
  return [
    { user: `team:${teamId}#member`, relation: "metadata_reader", object },
    { user: `team:${teamId}#member`, relation: "user", object },
  ];
}

export async function reconcileSecretRefOwnerRelationships(input: {
  secretId: string;
  owner: CredentialOwnerRef;
  ownerSubject?: string | null;
}): Promise<void> {
  await writeOpenFgaTupleDiff({
    writes: buildSecretRefOwnerTuples(input),
    deletes: [],
  });
}

export async function reconcileSecretRefShare(secretId: string, teamId: string): Promise<void> {
  await writeOpenFgaTupleDiff({
    writes: buildSecretRefShareTuples(secretId, teamId),
    deletes: [],
  });
}

export async function deleteSecretRefShare(secretId: string, teamId: string): Promise<void> {
  await writeOpenFgaTupleDiff({
    writes: [],
    deletes: buildSecretRefShareTuples(secretId, teamId),
  });
}

export async function deleteAllSecretRefRelationships(secretId: string): Promise<void> {
  if (!isOpenFgaReconciliationEnabled()) return;
  const object = objectId(secretId);
  const tuples: OpenFgaTupleKey[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await readOpenFgaTuples({ continuationToken });
    tuples.push(...page.tuples.map((tuple) => tuple.key));
    continuationToken = page.continuationToken;
  } while (continuationToken);

  await writeOpenFgaTupleDiff({
    writes: [],
    deletes: tuples.filter((tuple) => tuple.object === object),
  });
}
