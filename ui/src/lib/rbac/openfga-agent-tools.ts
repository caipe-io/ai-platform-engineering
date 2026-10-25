// assisted-by Codex Codex-sonnet-4-6

import type { DynamicAgentConfig } from "@/types/dynamic-agent";
import { reconcileTupleDiff } from "@/lib/authz";

import {
isOpenFgaReconciliationEnabled,
readOpenFgaTuples,
writeOpenFgaTupleDiff,
type OpenFgaReconcileResult,
type OpenFgaTupleKey,
type TeamResourceTupleDiff,
} from "./openfga";
import { buildTeamGrantTuples } from "./openfga-owned-resources";

type AllowedToolsConfig = Record<string, string[] | boolean>;

export interface AgentToolTupleDiffInput {
  agentId: string;
  previousAllowedTools?: AllowedToolsConfig;
  nextAllowedTools: AllowedToolsConfig;
  ownerSubject?: string | null;
  creatorSubject?: string | null;
  personalOwnerAccess?: boolean;
  previousPersonalOwnerAccess?: boolean;
  organizationId?: string | null;
  /**
   * The current desired owner-team slug. Required for team/global agents.
   * When set, we write the
   * canonical pair of inheritance tuples that grants team members
   * `can_use` and team admins `can_manage`. When `null`/`undefined` we
   * skip team writes for private agents.
   */
  ownerTeamSlug?: string | null;
  /**
   * Optional: the previous owner-team slug recorded on the agent before
   * this reconcile call. When provided and different from `ownerTeamSlug`,
   * we emit deletes for the stale `team:<slug>#member → agent#user` and
   * `team:<slug>#admin → agent#manager` tuples so owner-team transitions
   * (or migrations from a legacy team-less agent to a real team) do not
   * leave residue.
   *
   * Pass `undefined` for fresh creates (no previous state) and pass the
   * old value on updates. Idempotent: passing the same slug as
   * `ownerTeamSlug` is a no-op for the team tuples.
   */
  previousOwnerTeamSlug?: string | null;
  /**
   * Additional team slugs the agent is explicitly shared with (the
   * "Share with Teams" multi-select on the Agent editor — distinct from
   * the single owner team). Each entry produces the same two-tuple
   * inheritance pair as the owner team:
   *
   *   team:<slug>#member user agent:<id>     (can_use → chat and discover in admin list)
   *   team:<slug>#admin  manager agent:<id>  (can_manage → edit/disable/delete the agent)
   *
   * Empty array or `undefined` means "no additional shared teams"; the
   * owner-team tuples are still written. Slugs that match the owner team
   * are deduplicated. Invalid slugs are silently skipped.
   */
  nextSharedTeamSlugs?: readonly string[] | null;
  /**
   * Optional: the previous shared-team slugs recorded on the agent before
   * this reconcile call. Slugs that appear here but NOT in
   * `nextSharedTeamSlugs` are emitted as deletes so removing a team from
   * the multi-select genuinely revokes access (instead of the current
   * silent Mongo-only behaviour where the team kept its grant forever).
   *
   * Pass `undefined` (or `[]`) for fresh creates. Pass the previously
   * persisted set on updates so the diff is symmetric with
   * `previousOwnerTeamSlug`.
   */
  previousSharedTeamSlugs?: readonly string[] | null;
  /**
   * When `true` we write `user:* user agent:<id>` so every authenticated
   * user has `can_use` on this agent. Used for `visibility === 'global'`.
   */
  globalUserAccess?: boolean;
  /**
   * When the previous reconcile was global but the next state is not, we
   * emit a delete for `user:* user agent:<id>` so the agent loses the
   * everyone-can-use grant. Mirrors `previousOwnerTeamSlug`.
   */
  previousGlobalUserAccess?: boolean;
  /**
   * The platform unlinked service account's `sa_sub`, when known. When
   * `globalUserAccess` is set, we also write
   * `service_account:<sub> user agent:<id>` so callers with no linked user
   * identity (Slack/Webex bots routed through the unlinked SA) are treated
   * as "everyone" too — `user:*` only matches `user:`-typed subjects, never
   * `service_account:` ones. Pass `null`/`undefined` to skip this grant
   * (e.g. the unlinked SA isn't bootstrapped yet); the `user:*` grant is
   * unaffected either way.
   */
  unlinkedServiceAccountSub?: string | null;
  /**
   * When `true`, an admin has explicitly granted the unlinked service account
   * `can_use` on this agent via the Unlinked Access panel. That grant is owned
   * by the admin, not by the agent's visibility, so we must NOT delete the
   * `service_account:<sub> user agent:<id>` tuple when visibility leaves
   * `global` — only the panel's own removal may. The `user:*` wildcard grant is
   * still deleted on demotion (it has no explicit-grant equivalent). Defaults to
   * `false`: a demotion with no explicit grant revokes the unlinked SA as before.
   */
  unlinkedGrantIsExplicit?: boolean;
}

export interface ReconcileAgentToolTuplesInput extends AgentToolTupleDiffInput {
  failClosed?: boolean;
}

const OPENFGA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~@|*+=,/-]{0,191}$/;

function isValidOpenFgaId(value: unknown): value is string {
  return typeof value === "string" && OPENFGA_ID_PATTERN.test(value);
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

function normalizeAllowedTools(
  allowedTools?: AllowedToolsConfig,
): Map<string, Set<string>> {
  const normalized = new Map<string, Set<string>>();
  for (const [serverId, tools] of Object.entries(allowedTools ?? {})) {
    if (!isValidOpenFgaId(serverId)) continue;
    const normalizedTools = new Set<string>();
    if (!Array.isArray(tools) || tools.length === 0) {
      normalizedTools.add("*");
    } else {
      for (const tool of tools) {
        if (isValidOpenFgaId(tool)) {
          normalizedTools.add(tool);
        }
      }
    }
    if (normalizedTools.size > 0) {
      normalized.set(serverId, normalizedTools);
    }
  }
  return normalized;
}

function agentToolTuple(agentId: string, serverId: string, toolName: string): OpenFgaTupleKey {
  return {
    user: `agent:${agentId}`,
    relation: "caller",
    object: `tool:${serverId}/${toolName}`,
  };
}

export function buildAgentRelationshipTupleDiff(input: AgentToolTupleDiffInput): TeamResourceTupleDiff {
  if (!isValidOpenFgaId(input.agentId)) {
    throw new Error(`Invalid OpenFGA agent id: ${input.agentId}`);
  }

  const previous = normalizeAllowedTools(input.previousAllowedTools);
  const next = normalizeAllowedTools(input.nextAllowedTools);
  const writes: OpenFgaTupleKey[] = [];
  const deletes: OpenFgaTupleKey[] = [];

  if (input.creatorSubject && isValidOpenFgaId(input.creatorSubject)) {
    writes.push({
      user: `user:${input.creatorSubject}`,
      relation: "creator",
      object: `agent:${input.agentId}`,
    });
  }
  const legacyDirectOwnerAccess = input.personalOwnerAccess === undefined;
  if ((input.personalOwnerAccess || legacyDirectOwnerAccess) && input.ownerSubject && isValidOpenFgaId(input.ownerSubject)) {
    writes.push({
      user: `user:${input.ownerSubject}`,
      relation: "owner",
      object: `agent:${input.agentId}`,
    });
  } else if (input.previousPersonalOwnerAccess && input.ownerSubject && isValidOpenFgaId(input.ownerSubject)) {
    deletes.push({
      user: `user:${input.ownerSubject}`,
      relation: "owner",
      object: `agent:${input.agentId}`,
    });
  }
  if (!input.personalOwnerAccess && input.organizationId && isValidOpenFgaId(input.organizationId)) {
    writes.push({
      user: `organization:${input.organizationId}#admin`,
      relation: "manager",
      object: `agent:${input.agentId}`,
    });
  } else if (input.personalOwnerAccess && input.organizationId && isValidOpenFgaId(input.organizationId)) {
    deletes.push({
      user: `organization:${input.organizationId}#admin`,
      relation: "manager",
      object: `agent:${input.agentId}`,
    });
  }
  // Owner-team + shared-team grants are delegated to the shared
  // `buildTeamGrantTuples` primitive (spec 2026-06-03, US1 / FR-003). All
  // team members receive `user` (can_use / discover). Owner team members
  // additionally receive `manager` (full can_manage access per CAIPE policy).
  // Shared teams are use-only: `buildTeamGrantTuples` also writes an
  // `#admin manager` grant for every effective team (owner + shared), so we
  // drop that write for teams that are shared-only (not the owner) below —
  // sharing an agent with a team must never grant manage rights, even to
  // that team's admins.
  const agentObject = `agent:${input.agentId}`;
  const teamGrants = buildTeamGrantTuples({
    object: agentObject,
    memberRelations: ["user"],
    ownerTeamSlug: input.ownerTeamSlug,
    previousOwnerTeamSlug: input.previousOwnerTeamSlug,
    nextSharedTeamSlugs: input.nextSharedTeamSlugs,
    previousSharedTeamSlugs: input.previousSharedTeamSlugs,
  });
  const isSharedOnlyAdminManagerTuple = (tuple: OpenFgaTupleKey) =>
    tuple.relation === "manager" &&
    tuple.user.endsWith("#admin") &&
    tuple.user !== `team:${input.ownerTeamSlug}#admin`;
  writes.push(...teamGrants.writes.filter((tuple) => !isSharedOnlyAdminManagerTuple(tuple)));
  deletes.push(...teamGrants.deletes);

  // Explicitly revoke stale `#admin manager` grants for every currently (or
  // previously) shared, non-owner team — covers teams shared before this
  // fix shipped, and owner-team-demoted-to-shared transitions, neither of
  // which `buildTeamGrantTuples` would otherwise clean up since the team
  // stays in the effective set.
  const sharedAdminManagerRevokeSlugs = new Set<string>();
  for (const slug of [...(input.nextSharedTeamSlugs ?? []), ...(input.previousSharedTeamSlugs ?? [])]) {
    if (isValidOpenFgaId(slug) && slug !== input.ownerTeamSlug) {
      sharedAdminManagerRevokeSlugs.add(slug);
    }
  }
  for (const slug of sharedAdminManagerRevokeSlugs) {
    deletes.push({ user: `team:${slug}#admin`, relation: "manager", object: agentObject });
  }

  // Owner team members get full management access (can_manage). Write for
  // the current owner team; delete for the previous owner when it changes
  // so ownership transfers don't leave a stale manager grant on the old team.
  if (input.ownerTeamSlug && isValidOpenFgaId(input.ownerTeamSlug)) {
    writes.push({ user: `team:${input.ownerTeamSlug}#member`, relation: "manager", object: agentObject });
  }
  if (
    input.previousOwnerTeamSlug &&
    isValidOpenFgaId(input.previousOwnerTeamSlug) &&
    input.previousOwnerTeamSlug !== input.ownerTeamSlug
  ) {
    deletes.push({ user: `team:${input.previousOwnerTeamSlug}#member`, relation: "manager", object: agentObject });
  }

  // Drop legacy member `writer` grants from older reconciles so team members
  // cannot mutate agent config (color, prompt, tools) without manage rights.
  const writerRevokeSlugs = new Set<string>();
  if (input.ownerTeamSlug && isValidOpenFgaId(input.ownerTeamSlug)) {
    writerRevokeSlugs.add(input.ownerTeamSlug);
  }
  for (const slug of input.nextSharedTeamSlugs ?? []) {
    if (isValidOpenFgaId(slug)) writerRevokeSlugs.add(slug);
  }
  for (const slug of input.previousSharedTeamSlugs ?? []) {
    if (isValidOpenFgaId(slug)) writerRevokeSlugs.add(slug);
  }
  if (input.previousOwnerTeamSlug && isValidOpenFgaId(input.previousOwnerTeamSlug)) {
    writerRevokeSlugs.add(input.previousOwnerTeamSlug);
  }
  for (const slug of writerRevokeSlugs) {
    deletes.push({ user: `team:${slug}#member`, relation: "writer", object: agentObject });
  }

  // `visibility === 'global'` is encoded as a `user:* user agent:<id>`
  // tuple. We write/delete it here so the reconcile pass is the single
  // source of truth — `available/route.ts` no longer needs to repair it
  // at list time. Idempotent at the OpenFGA layer.
  if (input.globalUserAccess) {
    writes.push({
      user: "user:*",
      relation: "user",
      object: `agent:${input.agentId}`,
    });
    if (isValidOpenFgaId(input.unlinkedServiceAccountSub)) {
      writes.push({
        user: `service_account:${input.unlinkedServiceAccountSub}`,
        relation: "user",
        object: `agent:${input.agentId}`,
      });
    }
  } else if (input.previousGlobalUserAccess) {
    deletes.push({
      user: "user:*",
      relation: "user",
      object: `agent:${input.agentId}`,
    });
    if (isValidOpenFgaId(input.unlinkedServiceAccountSub) && !input.unlinkedGrantIsExplicit) {
      deletes.push({
        user: `service_account:${input.unlinkedServiceAccountSub}`,
        relation: "user",
        object: `agent:${input.agentId}`,
      });
    }
  }

  // An explicit admin grant persists independently of visibility. Re-assert it
  // for non-global agents (global agents already wrote it above) so the
  // reconcile sweep self-heals a grant that a prior visibility-driven delete
  // may have removed. Idempotent at the OpenFGA layer.
  if (
    !input.globalUserAccess &&
    input.unlinkedGrantIsExplicit &&
    isValidOpenFgaId(input.unlinkedServiceAccountSub)
  ) {
    writes.push({
      user: `service_account:${input.unlinkedServiceAccountSub}`,
      relation: "user",
      object: `agent:${input.agentId}`,
    });
  }

  for (const [serverId, tools] of next) {
    const previousTools = previous.get(serverId) ?? new Set<string>();
    for (const toolName of tools) {
      if (!previousTools.has(toolName)) {
        writes.push(agentToolTuple(input.agentId, serverId, toolName));
      }
    }
  }

  for (const [serverId, tools] of previous) {
    const nextTools = next.get(serverId) ?? new Set<string>();
    for (const toolName of tools) {
      if (!nextTools.has(toolName)) {
        deletes.push(agentToolTuple(input.agentId, serverId, toolName));
      }
    }
  }

  return {
    writes: uniqueTuples(writes),
    deletes: uniqueTuples(deletes),
  };
}

export function buildAgentToolTupleDiff(input: AgentToolTupleDiffInput): TeamResourceTupleDiff {
  return buildAgentRelationshipTupleDiff(input);
}

export async function reconcileAgentToolTuples(
  input: ReconcileAgentToolTuplesInput,
): Promise<OpenFgaReconcileResult> {
  return reconcileAgentRelationships(input);
}

export async function reconcileAgentRelationships(
  input: ReconcileAgentToolTuplesInput,
): Promise<OpenFgaReconcileResult> {
  const diff = buildAgentRelationshipTupleDiff(input);
  try {
    return await reconcileTupleDiff(diff, {
      caller: input.ownerSubject ? { type: "user", id: input.ownerSubject } : undefined,
      source: "agent_relationship_reconcile",
    });
  } catch (error) {
    if (input.failClosed ?? true) {
      throw error;
    }
    console.warn("[openfga-agent-tools] reconciliation failed:", error);
    return { enabled: isOpenFgaReconciliationEnabled(), writes: 0, deletes: 0 };
  }
}

export async function deleteAllAgentToolTuples(agentId: string): Promise<OpenFgaReconcileResult> {
  if (!isValidOpenFgaId(agentId)) {
    throw new Error(`Invalid OpenFGA agent id: ${agentId}`);
  }
  if (!isOpenFgaReconciliationEnabled()) {
    return { enabled: false, writes: 0, deletes: 0 };
  }

  const allTuples: OpenFgaTupleKey[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await readOpenFgaTuples({ continuationToken });
    allTuples.push(...page.tuples.map((tuple) => tuple.key));
    continuationToken = page.continuationToken;
  } while (continuationToken);

  return writeOpenFgaTupleDiff({
    writes: [],
    deletes: allTuples.filter((tuple) => tuple.user === `agent:${agentId}` || tuple.object === `agent:${agentId}`),
  });
}

export function allowedToolsFromAgent(agent: Pick<DynamicAgentConfig, "allowed_tools">): AllowedToolsConfig {
  return (agent.allowed_tools ?? {}) as AllowedToolsConfig;
}
