import { getCollection } from "@/lib/mongodb";
import {
readOpenFgaTuples,
writeOpenFgaTupleDiff,
type OpenFgaTupleKey,
} from "@/lib/rbac/openfga";

import type { MigrationApplyResult,MigrationPlanResult } from "./types";

export const ZIP_IMPORT_OWNER_BACKFILL_MIGRATION_ID =
  "zip_import_owner_backfill_v1";
export const ZIP_IMPORT_OWNER_BACKFILL_CONFIRMATION =
  "MIGRATE imported agent_skills OWNERS TO v3";
const RELEASE = "0.6.0";

interface ImportedSkillDoc {
  id?: string;
  owner_id?: string;
  category?: string;
  is_system?: boolean;
}

interface UserIdentityDoc {
  email?: string;
  keycloak_sub?: string;
  metadata?: { keycloak_sub?: string };
}

interface ZipImportOwnerBackfillInput {
  skills: ImportedSkillDoc[];
  subjectsByOwnerEmail: Map<string, string>;
  existingTuples: OpenFgaTupleKey[];
}

function tupleKey(tuple: OpenFgaTupleKey): string {
  return `${tuple.user}\n${tuple.relation}\n${tuple.object}`;
}

function normalizedEmail(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

export function deriveZipImportOwnerBackfillPlan(
  input: ZipImportOwnerBackfillInput,
): MigrationPlanResult & { tuples: OpenFgaTupleKey[] } {
  const existing = new Set(input.existingTuples.map(tupleKey));
  const writes: OpenFgaTupleKey[] = [];
  const warnings: string[] = [];
  let importedSkills = 0;
  let skillsRepaired = 0;
  let skillsSkipped = 0;
  let ownerSubjectsMissing = 0;

  for (const skill of input.skills) {
    if (skill.category !== "imported" || skill.is_system) continue;
    importedSkills += 1;
    const skillId = skill.id?.trim();
    const ownerEmail = normalizedEmail(skill.owner_id);
    const ownerSubject = input.subjectsByOwnerEmail.get(ownerEmail);
    if (!skillId || !ownerEmail || !ownerSubject) {
      skillsSkipped += 1;
      if (!ownerSubject) ownerSubjectsMissing += 1;
      warnings.push(
        `Skipping imported skill ${skillId || "(missing id)"}: stable owner subject not found for ${ownerEmail || "(missing owner)"}.`,
      );
      continue;
    }

    let changed = false;
    for (const relation of ["creator", "owner"] as const) {
      const tuple: OpenFgaTupleKey = {
        user: `user:${ownerSubject}`,
        relation,
        object: `skill:${skillId}`,
      };
      if (existing.has(tupleKey(tuple))) continue;
      existing.add(tupleKey(tuple));
      writes.push(tuple);
      changed = true;
    }
    if (changed) skillsRepaired += 1;
  }

  return {
    migration_id: ZIP_IMPORT_OWNER_BACKFILL_MIGRATION_ID,
    release: RELEASE,
    schema_area: "agent_skills",
    kind: "explicit",
    from_version: 2,
    to_version: 3,
    counts: {
      skills_scanned: input.skills.length,
      imported_skills: importedSkills,
      skills_repaired: skillsRepaired,
      skills_skipped: skillsSkipped,
      owner_subjects_missing: ownerSubjectsMissing,
      tuples_writes_planned: writes.length,
    },
    warnings,
    sample_diffs: writes.slice(0, 5).map((tuple, index) => ({
      collection: "openfga_tuples",
      id: `${ZIP_IMPORT_OWNER_BACKFILL_MIGRATION_ID}:${index}`,
      before: {},
      after: { ...tuple },
    })),
    tuple_writes_planned: writes.length,
    confirmation: ZIP_IMPORT_OWNER_BACKFILL_CONFIRMATION,
    tuples: writes,
  };
}

export async function planZipImportOwnerBackfillMigration(): Promise<
  MigrationPlanResult & { tuples: OpenFgaTupleKey[] }
> {
  const [skillsCollection, usersCollection] = await Promise.all([
    getCollection<ImportedSkillDoc>("agent_skills"),
    getCollection<UserIdentityDoc>("users"),
  ]);
  const [skills, users] = await Promise.all([
    skillsCollection
      .find({ category: "imported", is_system: { $ne: true } })
      .toArray(),
    usersCollection.find({}).toArray(),
  ]);
  const subjectsByOwnerEmail = new Map<string, string>();
  for (const user of users) {
    const email = normalizedEmail(user.email);
    const subject =
      user.keycloak_sub?.trim() || user.metadata?.keycloak_sub?.trim();
    if (email && subject) subjectsByOwnerEmail.set(email, subject);
  }

  const existingTuples: OpenFgaTupleKey[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await readOpenFgaTuples({
      continuationToken,
      pageSize: 100,
    });
    existingTuples.push(...page.tuples.map((entry) => entry.key));
    continuationToken = page.continuationToken;
  } while (continuationToken);

  return deriveZipImportOwnerBackfillPlan({
    skills,
    subjectsByOwnerEmail,
    existingTuples,
  });
}

export async function applyZipImportOwnerBackfillMigration(input: {
  plan: MigrationPlanResult & { tuples?: OpenFgaTupleKey[] };
  actor: string;
  now: string;
}): Promise<MigrationApplyResult> {
  const result = await writeOpenFgaTupleDiff({
    writes: input.plan.tuples ?? [],
    deletes: [],
  });
  return {
    ...input.plan,
    applied_counts: {
      tuple_writes_applied: result.writes,
      tuple_deletes_applied: result.deletes,
    },
    applied_at: input.now,
    applied_by: input.actor,
  };
}
