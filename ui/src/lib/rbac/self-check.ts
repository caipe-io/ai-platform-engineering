// assisted-by Codex Codex-sonnet-4-6

import type { Document,Filter } from "mongodb";

import { getCollection } from "@/lib/mongodb";
import {
  baselineAdminTuples,
  baselineMemberTuples,
  defaultBaselineFgaProfile,
  getBaselineFgaProfile,
  type BaselineFgaProfile,
} from "@/lib/rbac/baseline-access";
import {
  RBAC_SELF_CHECK_IDS,
  normalizeRbacSelfCheckIds,
  rbacSelfCheckDefinitionsFor,
} from "@/lib/rbac/self-check-catalog";
import {
  readOpenFgaTuples,
  type OpenFgaTuple,
  type OpenFgaTupleKey,
} from "@/lib/rbac/openfga";
import { openFgaResourceObject } from "@/lib/rbac/openfga-resource-ids";
import { organizationObjectId } from "@/lib/rbac/organization";
import type { UniversalRebacResourceType } from "@/types/rbac-universal";
import type {
  RbacSelfCheckFinding,
  RbacSelfCheckRepairBatch,
  RbacSelfCheckReport,
  RbacSelfCheckTuple,
} from "@/types/rbac-self-check";

const OPENFGA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~@|*+=,/-]{0,191}$/;
const DEFAULT_ORG_ID = "caipe";
const DEFAULT_SLACK_WORKSPACE = "CAIPE";
const DEFAULT_WEBEX_WORKSPACE = "Cisco";
const MAX_FINDINGS = 500;
const ORPHAN_CANDIDATE_LIMIT = 75;

type TupleSource =
  | "baseline_access"
  | "team_membership_sources"
  | "super_admins_org_admin_link"
  | "dynamic_agents.owner_subject"
  | "dynamic_agents.system_owner"
  | "dynamic_agents.org_admin_manager"
  | "dynamic_agents.owner/shared teams"
  | "dynamic_agents.visibility"
  | "platform_config.default_agent_id"
  | "dynamic_agents.allowed_tools"
  | "mcp_servers.config_driven"
  | "mcp_servers.owner_subject"
  | "mcp_servers.owner_team_slug"
  | "mcp_servers.org_admin_manager"
  | "llm_models.config_driven"
  | "llm_models.owner_subject"
  | "service_accounts.owning_team_id"
  | "service_accounts.gateway_baseline"
  | "service_accounts.scopes_snapshot"
  | "slack_channel_grants"
  | "channel_team_mappings"
  | "webex_space_grants"
  | "webex_space_team_mappings"
  | "credential_secret_refs.owner"
  | "credential_secret_refs.sharedWithTeams"
  | "sharing_access"
  | "conversations.created_by_service_account"
  | "conversations.sharing.shared_with_teams";

interface ExpectedTuple extends RbacSelfCheckTuple {
  source: TupleSource;
  resource?: { type: string; id: string; label?: string };
}

interface StaleReference {
  source: TupleSource;
  title: string;
  detail: string;
  fix: string;
  resource?: { type: string; id: string; label?: string };
}

interface DynamicAgentDoc extends Document {
  _id?: string;
  id?: string;
  name?: string;
  owner_id?: string;
  owner_subject?: string;
  owner_team_slug?: string;
  shared_with_teams?: string[];
  visibility?: string;
  is_system?: boolean;
  config_driven?: boolean;
  allowed_tools?: Record<string, string[] | boolean>;
}

interface TeamDoc extends Document {
  slug?: string;
  name?: string;
  status?: string;
}

interface TeamMembershipSourceDoc extends Document {
  team_slug?: string;
  user_subject?: string;
  relationship?: string;
}

interface McpServerDoc extends Document {
  _id?: string;
  id?: string;
  name?: string;
  owner_subject?: string;
  owner_team_slug?: string | null;
  config_driven?: boolean;
  source?: string;
}

interface LlmModelDoc extends Document {
  _id?: string;
  model_id?: string;
  owner_subject?: string;
  config_driven?: boolean;
}

interface ServiceAccountDoc extends Document {
  sa_sub?: string;
  name?: string;
  owning_team_id?: string;
  scopes_snapshot?: Array<{ type?: string; ref?: string }>;
}

interface MessagingGrantDoc extends Document {
  workspace_id?: string;
  channel_id?: string;
  space_id?: string;
  resource?: { type?: string; id?: string };
  actions?: string[];
}

interface SlackTeamMappingDoc extends Document {
  slack_workspace_id?: string;
  slack_channel_id?: string;
  team_slug?: string;
}

interface WebexTeamMappingDoc extends Document {
  webex_workspace_id?: string;
  webex_space_id?: string;
  team_slug?: string;
}

interface CredentialSecretRefDoc extends Document {
  id?: string;
  name?: string;
  owner?: { type?: string; id?: string };
  sharedWithTeams?: string[];
}

interface UserDoc extends Document {
  email?: string;
  name?: string;
  keycloak_sub?: string;
  role?: string;
  enabled?: boolean;
  status?: string;
  metadata?: {
    keycloak_sub?: string;
    role?: string;
  };
}

interface SharingAccessDoc extends Document {
  conversation_id?: string;
  granted_to?: string;
  permission?: string;
}

interface ConversationDoc extends Document {
  _id?: string;
  created_by_service_account?: string;
  sharing?: {
    shared_with_teams?: string[];
    team_permissions?: Record<string, string>;
  };
}

interface SkillDoc extends Document {
  id?: string;
  _id?: string;
}

interface TaskDoc extends Document {
  id?: string;
  _id?: string;
}

interface ToolCatalogDoc extends Document {
  server_id?: string;
  tool_id?: string;
}

interface PlatformConfigDoc extends Document {
  default_agent_id?: string;
}

export interface RbacSelfCheckInventoryInput {
  actualTuples: RbacSelfCheckTuple[];
  teams: TeamDoc[];
  teamMembershipSources: TeamMembershipSourceDoc[];
  dynamicAgents: DynamicAgentDoc[];
  mcpServers: McpServerDoc[];
  llmModels: LlmModelDoc[];
  serviceAccounts: ServiceAccountDoc[];
  slackChannelGrants: MessagingGrantDoc[];
  slackChannelTeamMappings: SlackTeamMappingDoc[];
  webexSpaceGrants: MessagingGrantDoc[];
  webexSpaceTeamMappings: WebexTeamMappingDoc[];
  credentialSecretRefs: CredentialSecretRefDoc[];
  users: UserDoc[];
  sharingAccess: SharingAccessDoc[];
  conversations: ConversationDoc[];
  skills: SkillDoc[];
  tasks: TaskDoc[];
  mcpToolCatalog: ToolCatalogDoc[];
  platformConfig?: PlatformConfigDoc | null;
  baselineProfile?: BaselineFgaProfile;
  generatedAt?: string;
}

export interface RbacSelfCheckOptions {
  maxFindings?: number;
  orphanCandidateLimit?: number;
  checks?: string[];
}

interface ResolvedSelfCheckScope {
  selected: string[];
  labels: string[];
  all: boolean;
  sourceSet: Set<string>;
  orphanObjectTypeSet: Set<string>;
}

function resolveSelfCheckScope(checks?: string[]): ResolvedSelfCheckScope {
  const selected = normalizeRbacSelfCheckIds(checks);
  const definitions = rbacSelfCheckDefinitionsFor(selected);
  return {
    selected,
    labels: definitions.map((definition) => definition.label),
    all: selected.length === RBAC_SELF_CHECK_IDS.length,
    sourceSet: new Set(definitions.flatMap((definition) => definition.sources)),
    orphanObjectTypeSet: new Set(definitions.flatMap((definition) => definition.orphanObjectTypes)),
  };
}

function isValidOpenFgaId(value: unknown): value is string {
  return typeof value === "string" && OPENFGA_ID_PATTERN.test(value);
}

function tupleKey(tuple: RbacSelfCheckTuple): string {
  return `${tuple.user}\n${tuple.relation}\n${tuple.object}`;
}

function uniqueTuples<T extends RbacSelfCheckTuple>(tuples: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const tuple of tuples) {
    const key = tupleKey(tuple);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tuple);
  }
  return out;
}

function sortedRecord(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

function increment(record: Record<string, number>, key: string, by = 1): void {
  record[key] = (record[key] ?? 0) + by;
}

function expected(
  source: TupleSource,
  user: string,
  relation: string,
  object: string,
  resource?: ExpectedTuple["resource"],
): ExpectedTuple {
  return { user, relation, object, source, ...(resource ? { resource } : {}) };
}

function stale(
  source: TupleSource,
  title: string,
  detail: string,
  fix: string,
  resource?: StaleReference["resource"],
): StaleReference {
  return { source, title, detail, fix, ...(resource ? { resource } : {}) };
}

function normalizeAgentId(agent: DynamicAgentDoc): string {
  return String(agent._id ?? agent.id ?? "").trim();
}

function normalizeObjectId(doc: Document): string {
  return String(doc._id ?? doc.id ?? "").trim();
}

function normalizeLlmModelId(model: LlmModelDoc): string {
  return String(model.model_id ?? model._id ?? "").trim();
}

function grantResourceObject(type: string, id: string): string {
  return openFgaResourceObject(type as UniversalRebacResourceType, id);
}

function actionToBaseRelation(action: string): string | null {
  const mapping: Record<string, string> = {
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
  };
  return mapping[action] ?? null;
}

function normalizeAllowedTools(allowedTools: Record<string, string[] | boolean> | undefined): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [serverId, tools] of Object.entries(allowedTools ?? {})) {
    if (!isValidOpenFgaId(serverId)) continue;
    if (!Array.isArray(tools) || tools.length === 0) {
      out.push([serverId, "*"]);
      continue;
    }
    for (const toolName of tools) {
      if (isValidOpenFgaId(toolName)) {
        out.push([serverId, toolName]);
      }
    }
  }
  return out;
}

function teamGrantTuples(input: {
  object: string;
  source: TupleSource;
  ownerTeamSlug?: string | null;
  sharedTeamSlugs?: string[];
  memberRelations: string[];
  knownTeamSlugs: Set<string>;
  resource?: ExpectedTuple["resource"];
}): { tuples: ExpectedTuple[]; staleReferences: StaleReference[] } {
  const tuples: ExpectedTuple[] = [];
  const staleReferences: StaleReference[] = [];
  const teamSlugs = new Set<string>();
  if (input.ownerTeamSlug) teamSlugs.add(input.ownerTeamSlug);
  for (const slug of input.sharedTeamSlugs ?? []) teamSlugs.add(slug);

  for (const teamSlug of teamSlugs) {
    if (!isValidOpenFgaId(teamSlug)) continue;
    if (!input.knownTeamSlugs.has(teamSlug)) {
      staleReferences.push(stale(
        input.source,
        `Unknown team ${teamSlug}`,
        `${input.object} references team ${teamSlug}, but that team is not active in Mongo.`,
        "Update the resource owner/share settings to an active team, or restore the missing team.",
        { type: "team", id: teamSlug },
      ));
      continue;
    }
    for (const relation of input.memberRelations) {
      tuples.push(expected(input.source, `team:${teamSlug}#member`, relation, input.object, input.resource));
    }
    // Sharing is use-only: only the owner team's admins get `manager` (can_manage).
    // Mirrors the write-side filter in openfga-agent-tools.ts (isSharedOnlyAdminManagerTuple) —
    // without this, self-check expects an `#admin manager` grant for every shared team and
    // flags it as "missing" once the reconciler stops writing/keeps deleting it.
    if (teamSlug === input.ownerTeamSlug) {
      tuples.push(expected(input.source, `team:${teamSlug}#admin`, "manager", input.object, input.resource));
    }
  }
  return { tuples, staleReferences };
}

function scopeResourceExists(type: string, id: string, resourceIndex: ResourceIndex): boolean {
  switch (type) {
    case "agent":
      return resourceIndex.agentIds.has(id);
    case "tool": {
      if (id === "*") return true;
      const [serverId] = id.split("/");
      return resourceIndex.mcpServerIds.has(serverId) || resourceIndex.toolServerIds.has(serverId);
    }
    case "skill":
      return resourceIndex.skillIds.has(id);
    case "task":
      return resourceIndex.taskIds.has(id);
    case "mcp_server":
      return resourceIndex.mcpServerIds.has(id);
    default:
      return true;
  }
}

interface ResourceIndex {
  teamSlugs: Set<string>;
  // Slugs whose team doc has status "archived". These stay in `teamSlugs` (so
  // the membership roster is still recognized and not flagged as a deleted-team
  // orphan), but they grant NOTHING: archiving strips a team's resource-grant
  // tuples, so the self-check must neither expect those grants (else repair
  // re-creates them) nor treat their absence as drift.
  archivedTeamSlugs: Set<string>;
  agentIds: Set<string>;
  agentAccessByObject: Map<string, {
    label?: string;
    visibility?: string;
    teamSlugs: Set<string>;
  }>;
  mcpServerIds: Set<string>;
  mcpServersByObject: Map<string, {
    label?: string;
    configDriven: boolean;
    source?: string;
  }>;
  toolServerIds: Set<string>;
  llmModelIds: Set<string>;
  skillIds: Set<string>;
  taskIds: Set<string>;
  conversationIds: Set<string>;
  secretRefIds: Set<string>;
  userSubjectsByEmail: Map<string, string>;
  slackChannelTeamsByObject: Map<string, Set<string>>;
  webexSpaceTeamsByObject: Map<string, Set<string>>;
}

function buildResourceIndex(input: RbacSelfCheckInventoryInput): ResourceIndex {
  const teamSlugs = new Set(input.teams.map((team) => team.slug).filter(isValidOpenFgaId));
  const archivedTeamSlugs = new Set(
    input.teams
      .filter((team) => team.status === "archived")
      .map((team) => team.slug)
      .filter(isValidOpenFgaId),
  );
  const agentAccessByObject = new Map<string, { label?: string; visibility?: string; teamSlugs: Set<string> }>();
  for (const agent of input.dynamicAgents) {
    const agentId = normalizeAgentId(agent);
    if (!isValidOpenFgaId(agentId)) continue;
    const currentTeamSlugs = new Set<string>();
    if (isValidOpenFgaId(agent.owner_team_slug) && teamSlugs.has(agent.owner_team_slug)) {
      currentTeamSlugs.add(agent.owner_team_slug);
    }
    for (const teamSlug of agent.shared_with_teams ?? []) {
      if (isValidOpenFgaId(teamSlug) && teamSlugs.has(teamSlug)) {
        currentTeamSlugs.add(teamSlug);
      }
    }
    agentAccessByObject.set(`agent:${agentId}`, {
      ...(agent.name ? { label: agent.name } : {}),
      ...(agent.visibility ? { visibility: agent.visibility } : {}),
      teamSlugs: currentTeamSlugs,
    });
  }

  const mcpServersByObject = new Map<string, { label?: string; configDriven: boolean; source?: string }>();
  for (const server of input.mcpServers) {
    const serverId = normalizeObjectId(server);
    if (!isValidOpenFgaId(serverId)) continue;
    mcpServersByObject.set(`mcp_server:${serverId}`, {
      ...(server.name ? { label: server.name } : {}),
      configDriven: server.config_driven !== false,
      ...(server.source ? { source: server.source } : {}),
    });
  }

  const slackChannelTeamsByObject = new Map<string, Set<string>>();
  for (const mapping of input.slackChannelTeamMappings) {
    const teamSlug = mapping.team_slug;
    const channelId = mapping.slack_channel_id;
    if (!channelId || !isValidOpenFgaId(teamSlug)) continue;
    const object = `slack_channel:${mapping.slack_workspace_id ?? DEFAULT_SLACK_WORKSPACE}--${channelId}`;
    const teams = slackChannelTeamsByObject.get(object) ?? new Set<string>();
    teams.add(teamSlug);
    slackChannelTeamsByObject.set(object, teams);
  }

  const webexSpaceTeamsByObject = new Map<string, Set<string>>();
  for (const mapping of input.webexSpaceTeamMappings) {
    const teamSlug = mapping.team_slug;
    const spaceId = mapping.webex_space_id;
    if (!spaceId || !isValidOpenFgaId(teamSlug)) continue;
    const object = `webex_space:${mapping.webex_workspace_id ?? DEFAULT_WEBEX_WORKSPACE}--${spaceId}`;
    const teams = webexSpaceTeamsByObject.get(object) ?? new Set<string>();
    teams.add(teamSlug);
    webexSpaceTeamsByObject.set(object, teams);
  }

  return {
    teamSlugs,
    archivedTeamSlugs,
    agentIds: new Set(input.dynamicAgents.map(normalizeAgentId).filter(isValidOpenFgaId)),
    agentAccessByObject,
    mcpServerIds: new Set(input.mcpServers.map(normalizeObjectId).filter(isValidOpenFgaId)),
    mcpServersByObject,
    toolServerIds: new Set(input.mcpToolCatalog.map((tool) => tool.server_id).filter(isValidOpenFgaId)),
    llmModelIds: new Set(input.llmModels.map(normalizeLlmModelId).filter(Boolean)),
    skillIds: new Set(input.skills.map((skill) => String(skill.id ?? skill._id ?? "").trim()).filter(isValidOpenFgaId)),
    taskIds: new Set(input.tasks.map((task) => String(task.id ?? task._id ?? "").trim()).filter(isValidOpenFgaId)),
    conversationIds: new Set(input.conversations.map((conversation) => String(conversation._id ?? "").trim()).filter(Boolean)),
    secretRefIds: new Set(input.credentialSecretRefs.map((secret) => secret.id).filter(isValidOpenFgaId)),
    userSubjectsByEmail: new Map(
      input.users
        .map((user): [string, string] | null => {
          const email = String(user.email ?? "").trim().toLowerCase();
          const subject = String(user.keycloak_sub ?? "").trim();
          return email && isValidOpenFgaId(subject) ? [email, subject] : null;
        })
        .filter((entry): entry is [string, string] => entry !== null),
    ),
    slackChannelTeamsByObject,
    webexSpaceTeamsByObject,
  };
}

function userSubject(user: UserDoc): string | null {
  const subject = String(user.keycloak_sub ?? user.metadata?.keycloak_sub ?? "").trim();
  return isValidOpenFgaId(subject) ? subject : null;
}

function userRole(user: UserDoc): string | null {
  const role = String(user.role ?? user.metadata?.role ?? "").trim().toLowerCase();
  return role || null;
}

function activeUser(user: UserDoc): boolean {
  return user.enabled !== false && user.status !== "deleted" && Boolean(userSubject(user));
}

function currentBaselineAccessTuples(
  input: RbacSelfCheckInventoryInput,
  actualKeys: Set<string>,
): ExpectedTuple[] {
  const tuples: ExpectedTuple[] = [];
  const profile = input.baselineProfile ?? defaultBaselineFgaProfile();
  const agentGatewayAdminTuple = {
    user: `${organizationObjectId()}#admin`,
    relation: "manager",
    object: "mcp_server:agentgateway",
  };
  if (actualKeys.has(tupleKey(agentGatewayAdminTuple))) {
    tuples.push(expected(
      "baseline_access",
      agentGatewayAdminTuple.user,
      agentGatewayAdminTuple.relation,
      agentGatewayAdminTuple.object,
      { type: "mcp_server", id: "agentgateway", label: "AgentGateway" },
    ));
  }

  for (const user of input.users) {
    if (!activeUser(user)) continue;
    const subject = userSubject(user);
    if (!subject) continue;
    const role = userRole(user);
    const resource = {
      type: "user",
      id: subject,
      label: user.name ?? user.email ?? subject,
    };

    // The member baseline is authoritative for every active user: it is always
    // expected, so a user who was provisioned but never interactively logged
    // into the web UI (e.g. an Okta directory-sync user) has their MISSING
    // member grants — including the `mcp_gateway:list` caller tuple that
    // AgentGateway's coarse ext_authz gate requires — flagged as `missing` and
    // made repairable. Previously these tuples were only expected when already
    // present in OpenFGA, so the self-check could never surface or repair a
    // user who was missing them, which is exactly how sync-only users ended up
    // with zero MCP tools.
    for (const tuple of baselineMemberTuples(subject, profile)) {
      tuples.push(expected("baseline_access", tuple.user, tuple.relation, tuple.object, resource));
    }

    // The admin baseline is authoritative only for users Mongo marks as admin
    // (there is no trustworthy admin signal otherwise). For a user whose role
    // is unknown we don't force-repair admin grants; we only recognize the ones
    // already present so they are not mis-reported as orphan candidates.
    const adminTuples = baselineAdminTuples(subject, profile);
    if (role === "admin") {
      for (const tuple of adminTuples) {
        tuples.push(expected("baseline_access", tuple.user, tuple.relation, tuple.object, resource));
      }
    } else if (role === null && adminTuples.some((tuple) => actualKeys.has(tupleKey(tuple)))) {
      for (const tuple of adminTuples) {
        if (!actualKeys.has(tupleKey(tuple))) continue;
        tuples.push(expected("baseline_access", tuple.user, tuple.relation, tuple.object, resource));
      }
    }
  }
  return uniqueTuples(tuples);
}

function buildExpectedTuplesAndStaleReferences(
  input: RbacSelfCheckInventoryInput,
  resourceIndex: ResourceIndex,
): { tuples: ExpectedTuple[]; staleReferences: StaleReference[] } {
  const tuples: ExpectedTuple[] = [];
  const staleReferences: StaleReference[] = [];
  const orgObject = organizationObjectId() || `organization:${DEFAULT_ORG_ID}`;

  const defaultAgentId = String(input.platformConfig?.default_agent_id ?? "").trim();
  if (isValidOpenFgaId(defaultAgentId)) {
    const object = `agent:${defaultAgentId}`;
    const agent = resourceIndex.agentAccessByObject.get(object);
    if (agent) {
      tuples.push(expected(
        "platform_config.default_agent_id",
        "user:*",
        "user",
        object,
        { type: "agent", id: defaultAgentId, ...(agent.label ? { label: agent.label } : {}) },
      ));
    } else {
      staleReferences.push(stale(
        "platform_config.default_agent_id",
        `Default agent references missing agent ${defaultAgentId}`,
        `platform_config.default_agent_id=${defaultAgentId}, but that agent is not active in dynamic_agents.`,
        "Pick an active default agent or restore the missing agent.",
        { type: "agent", id: defaultAgentId },
      ));
    }
  }

  for (const source of input.teamMembershipSources) {
    const teamSlug = source.team_slug;
    const userSubject = source.user_subject;
    const relationship = source.relationship;
    if (!isValidOpenFgaId(teamSlug) || !isValidOpenFgaId(userSubject)) continue;
    if (relationship !== "member" && relationship !== "admin") continue;
    if (!resourceIndex.teamSlugs.has(teamSlug)) {
      const generatedHint = teamSlug.startsWith("rbac-")
        ? " This looks like generated RBAC test data."
        : "";
      staleReferences.push(stale(
        "team_membership_sources",
        `Stale membership source for deleted team ${teamSlug}`,
        `user:${userSubject} is still active in team_membership_sources for team ${teamSlug}, but the team is not active.${generatedHint}`,
        "Restore the team if it should exist, or remove this stale team_membership_sources row so it cannot recreate access drift.",
        { type: "team", id: teamSlug },
      ));
      continue;
    }
    const subject = `user:${userSubject}`;
    const object = `team:${teamSlug}`;
    tuples.push(expected("team_membership_sources", subject, relationship, object));
    if (relationship === "admin") {
      // assisted-by Codex Codex-sonnet-4-6
      // Team admins also receive member access so runtime member checks pass.
      tuples.push(expected("team_membership_sources", subject, "member", object));
    }
  }

  if (resourceIndex.teamSlugs.has("super-admins")) {
    tuples.push(expected("super_admins_org_admin_link", "team:super-admins#admin", "admin", orgObject));
  }

  for (const agent of input.dynamicAgents) {
    const agentId = normalizeAgentId(agent);
    if (!isValidOpenFgaId(agentId)) continue;
    const object = `agent:${agentId}`;
    const resource = { type: "agent", id: agentId, label: agent.name };
    if (isValidOpenFgaId(agent.owner_subject)) {
      tuples.push(expected("dynamic_agents.owner_subject", `user:${agent.owner_subject}`, "owner", object, resource));
    } else if (agent.owner_id === "system" || agent.is_system === true || agent.config_driven === true) {
      tuples.push(expected("dynamic_agents.system_owner", "user:system", "owner", object, resource));
    }
    tuples.push(expected("dynamic_agents.org_admin_manager", `${orgObject}#admin`, "manager", object, resource));
    const teamGrants = teamGrantTuples({
      object,
      source: "dynamic_agents.owner/shared teams",
      ownerTeamSlug: agent.owner_team_slug,
      sharedTeamSlugs: agent.shared_with_teams,
      memberRelations: ["user"],
      knownTeamSlugs: resourceIndex.teamSlugs,
      resource,
    });
    tuples.push(...teamGrants.tuples);
    staleReferences.push(...teamGrants.staleReferences);
    // The agent reconciler also writes team:<ownerTeamSlug>#member manager for the
    // owner team specifically (full can_manage for owner-team members). This is
    // separate from the #admin manager tuple that teamGrantTuples emits for all
    // teams. Without this, the tuple shows up as "unowned" after an ownership
    // transfer because the self-check never expected it.
    if (isValidOpenFgaId(agent.owner_team_slug) && resourceIndex.teamSlugs.has(agent.owner_team_slug)) {
      tuples.push(expected("dynamic_agents.owner/shared teams", `team:${agent.owner_team_slug}#member`, "manager", object, resource));
    }
    if (agent.visibility === "global") {
      tuples.push(expected("dynamic_agents.visibility", "user:*", "user", object, resource));
    }
    if (scopeResourceExists("tool", "platform/*", resourceIndex)) {
      tuples.push(expected(
        "dynamic_agents.allowed_tools",
        `agent:${agentId}`,
        "caller",
        "tool:platform/*",
        resource,
      ));
    }
    for (const [serverId, toolName] of normalizeAllowedTools(agent.allowed_tools)) {
      const toolRef = `${serverId}/${toolName}`;
      if (!scopeResourceExists("tool", toolRef, resourceIndex)) {
        staleReferences.push(stale(
          "dynamic_agents.allowed_tools",
          `Agent references missing tool ${toolRef}`,
          `${agent.name ?? agentId} is configured to call ${toolRef}, but no matching MCP server or tool catalog entry exists.`,
          "Remove the stale tool from the agent or restore the MCP server/tool catalog entry.",
          { type: "tool", id: toolRef },
        ));
        continue;
      }
      tuples.push(expected("dynamic_agents.allowed_tools", `agent:${agentId}`, "caller", `tool:${toolRef}`, resource));
    }
  }

  for (const server of input.mcpServers) {
    const serverId = normalizeObjectId(server);
    if (!isValidOpenFgaId(serverId)) continue;
    const object = `mcp_server:${serverId}`;
    const resource = { type: "mcp_server", id: serverId };
    if (server.config_driven !== false) {
      tuples.push(expected("mcp_servers.config_driven", `${orgObject}#member`, "reader", object, resource));
      tuples.push(expected("mcp_servers.config_driven", `${orgObject}#member`, "user", object, resource));
      tuples.push(expected("mcp_servers.config_driven", `${orgObject}#admin`, "manager", object, resource));
    } else {
      if (isValidOpenFgaId(server.owner_subject)) {
        tuples.push(expected("mcp_servers.owner_subject", `user:${server.owner_subject}`, "owner", object, resource));
      }
      if (isValidOpenFgaId(server.owner_team_slug)) {
        if (resourceIndex.teamSlugs.has(server.owner_team_slug)) {
          tuples.push(expected("mcp_servers.owner_team_slug", `team:${server.owner_team_slug}#member`, "reader", object, resource));
          tuples.push(expected("mcp_servers.owner_team_slug", `team:${server.owner_team_slug}#member`, "user", object, resource));
          tuples.push(expected("mcp_servers.owner_team_slug", `team:${server.owner_team_slug}#member`, "invoker", object, resource));
          tuples.push(expected("mcp_servers.owner_team_slug", `team:${server.owner_team_slug}#admin`, "manager", object, resource));
        } else {
          staleReferences.push(stale(
            "mcp_servers.owner_team_slug",
            `MCP server references missing team ${server.owner_team_slug}`,
            `${serverId} has owner_team_slug=${server.owner_team_slug}, but that team is not active.`,
            "Move the MCP server to an active owner team or restore the missing team.",
            { type: "team", id: server.owner_team_slug },
          ));
        }
      }
      tuples.push(expected("mcp_servers.org_admin_manager", `${orgObject}#admin`, "manager", object, resource));
    }
  }

  for (const model of input.llmModels) {
    const modelId = normalizeLlmModelId(model);
    if (!modelId) continue;
    const object = openFgaResourceObject("llm_model", modelId);
    const resource = { type: "llm_model", id: modelId };
    if (model.config_driven !== false) {
      tuples.push(expected("llm_models.config_driven", `${orgObject}#member`, "reader", object, resource));
      tuples.push(expected("llm_models.config_driven", `${orgObject}#admin`, "manager", object, resource));
    } else if (isValidOpenFgaId(model.owner_subject)) {
      tuples.push(expected("llm_models.owner_subject", `user:${model.owner_subject}`, "owner", object, resource));
    }
  }

  for (const account of input.serviceAccounts) {
    const subject = account.sa_sub;
    if (!isValidOpenFgaId(subject)) continue;
    const serviceAccountObject = `service_account:${subject}`;
    const resource = { type: "service_account", id: subject, label: account.name };
    if (isValidOpenFgaId(account.owning_team_id)) {
      if (resourceIndex.teamSlugs.has(account.owning_team_id)) {
        tuples.push(expected(
          "service_accounts.owning_team_id",
          `team:${account.owning_team_id}#member`,
          "owner_team",
          serviceAccountObject,
          resource,
        ));
      } else {
        staleReferences.push(stale(
          "service_accounts.owning_team_id",
          `Service account references missing team ${account.owning_team_id}`,
          `${account.name ?? subject} is owned by ${account.owning_team_id}, but that team is not active.`,
          "Move the service account to an active team or restore the missing team.",
          { type: "team", id: account.owning_team_id },
        ));
      }
    }
    tuples.push(expected("service_accounts.gateway_baseline", serviceAccountObject, "caller", "mcp_gateway:list", resource));
    for (const scope of account.scopes_snapshot ?? []) {
      const type = String(scope.type ?? "");
      const ref = String(scope.ref ?? "").trim();
      if (!isValidOpenFgaId(ref) && type !== "tool") continue;
      if (type === "agent") {
        if (!resourceIndex.agentIds.has(ref)) {
          staleReferences.push(stale(
            "service_accounts.scopes_snapshot",
            `Service account scope references missing agent ${ref}`,
            `${account.name ?? subject} still has an agent scope for ${ref}, but that agent is not in dynamic_agents.`,
            "Remove the stale scope from the service account or restore the missing agent.",
            { type: "agent", id: ref },
          ));
          continue;
        }
        tuples.push(expected("service_accounts.scopes_snapshot", serviceAccountObject, "user", `agent:${ref}`, resource));
      }
      if (type === "tool") {
        if (!scopeResourceExists("tool", ref, resourceIndex)) {
          staleReferences.push(stale(
            "service_accounts.scopes_snapshot",
            `Service account scope references missing tool ${ref}`,
            `${account.name ?? subject} still has a tool scope for ${ref}, but no matching MCP server or tool catalog entry exists.`,
            "Remove the stale scope from the service account or restore the MCP server/tool catalog entry.",
            { type: "tool", id: ref },
          ));
          continue;
        }
        tuples.push(expected("service_accounts.scopes_snapshot", serviceAccountObject, "caller", `tool:${ref}`, resource));
      }
    }
  }

  for (const grant of input.slackChannelGrants) {
    const channelId = grant.channel_id;
    const workspaceId = grant.workspace_id ?? DEFAULT_SLACK_WORKSPACE;
    const resource = grant.resource;
    if (!channelId || !resource?.type || !resource.id) continue;
    if (!scopeResourceExists(resource.type, resource.id, resourceIndex)) {
      staleReferences.push(stale(
        "slack_channel_grants",
        `Slack grant references missing ${resource.type} ${resource.id}`,
        `Slack channel ${workspaceId}/${channelId} grants ${resource.type}:${resource.id}, but that resource was not found.`,
        "Remove the stale Slack grant or restore the target resource.",
        { type: resource.type, id: resource.id },
      ));
      continue;
    }
    for (const action of grant.actions ?? []) {
      const relation = actionToBaseRelation(action);
      if (!relation) continue;
      tuples.push(expected(
        "slack_channel_grants",
        `slack_channel:${workspaceId}--${channelId}`,
        relation,
        grantResourceObject(resource.type, resource.id),
        { type: "slack_channel", id: `${workspaceId}--${channelId}` },
      ));
    }
  }

  for (const mapping of input.slackChannelTeamMappings) {
    const teamSlug = mapping.team_slug;
    const channelId = mapping.slack_channel_id;
    const workspaceId = mapping.slack_workspace_id ?? DEFAULT_SLACK_WORKSPACE;
    if (!channelId || !isValidOpenFgaId(teamSlug)) continue;
    if (!resourceIndex.teamSlugs.has(teamSlug)) {
      staleReferences.push(stale(
        "channel_team_mappings",
        `Slack channel mapping references missing team ${teamSlug}`,
        `Slack channel ${workspaceId}/${channelId} is assigned to ${teamSlug}, but that team is not active.`,
        "Assign the channel to an active team or restore the missing team.",
        { type: "team", id: teamSlug },
      ));
      continue;
    }
    const object = `slack_channel:${workspaceId}--${channelId}`;
    tuples.push(expected("channel_team_mappings", `team:${teamSlug}#admin`, "manager", object));
    tuples.push(expected("channel_team_mappings", `team:${teamSlug}#member`, "user", object));
    tuples.push(expected("channel_team_mappings", `team:${teamSlug}#member`, "manager", object));
  }

  for (const grant of input.webexSpaceGrants) {
    const spaceId = grant.space_id;
    const workspaceId = grant.workspace_id ?? DEFAULT_WEBEX_WORKSPACE;
    const resource = grant.resource;
    if (!spaceId || !resource?.type || !resource.id) continue;
    if (!scopeResourceExists(resource.type, resource.id, resourceIndex)) {
      staleReferences.push(stale(
        "webex_space_grants",
        `Webex grant references missing ${resource.type} ${resource.id}`,
        `Webex space ${workspaceId}/${spaceId} grants ${resource.type}:${resource.id}, but that resource was not found.`,
        "Remove the stale Webex grant or restore the target resource.",
        { type: resource.type, id: resource.id },
      ));
      continue;
    }
    for (const action of grant.actions ?? []) {
      const relation = actionToBaseRelation(action);
      if (!relation) continue;
      tuples.push(expected(
        "webex_space_grants",
        `webex_space:${workspaceId}--${spaceId}`,
        relation,
        grantResourceObject(resource.type, resource.id),
        { type: "webex_space", id: `${workspaceId}--${spaceId}` },
      ));
    }
  }

  for (const mapping of input.webexSpaceTeamMappings) {
    const teamSlug = mapping.team_slug;
    const spaceId = mapping.webex_space_id;
    const workspaceId = mapping.webex_workspace_id ?? DEFAULT_WEBEX_WORKSPACE;
    if (!spaceId || !isValidOpenFgaId(teamSlug)) continue;
    if (!resourceIndex.teamSlugs.has(teamSlug)) {
      staleReferences.push(stale(
        "webex_space_team_mappings",
        `Webex space mapping references missing team ${teamSlug}`,
        `Webex space ${workspaceId}/${spaceId} is assigned to ${teamSlug}, but that team is not active.`,
        "Assign the space to an active team or restore the missing team.",
        { type: "team", id: teamSlug },
      ));
      continue;
    }
    const object = `webex_space:${workspaceId}--${spaceId}`;
    tuples.push(expected("webex_space_team_mappings", `team:${teamSlug}#member`, "manager", object));
    tuples.push(expected("webex_space_team_mappings", `team:${teamSlug}#member`, "user", object));
  }

  for (const secret of input.credentialSecretRefs) {
    const secretId = secret.id;
    if (!isValidOpenFgaId(secretId)) continue;
    const object = `secret_ref:${secretId}`;
    const resource = { type: "secret_ref", id: secretId, label: secret.name };
    if (secret.owner?.type === "user" && isValidOpenFgaId(secret.owner.id)) {
      for (const relation of ["metadata_reader", "user", "manager", "auditor"]) {
        tuples.push(expected("credential_secret_refs.owner", `user:${secret.owner.id}`, relation, object, resource));
      }
    }
    if (secret.owner?.type === "team" && isValidOpenFgaId(secret.owner.id)) {
      if (resourceIndex.teamSlugs.has(secret.owner.id)) {
        tuples.push(expected("credential_secret_refs.owner", `team:${secret.owner.id}#member`, "metadata_reader", object, resource));
        tuples.push(expected("credential_secret_refs.owner", `team:${secret.owner.id}#member`, "user", object, resource));
        tuples.push(expected("credential_secret_refs.owner", `team:${secret.owner.id}#admin`, "manager", object, resource));
        tuples.push(expected("credential_secret_refs.owner", `team:${secret.owner.id}#admin`, "auditor", object, resource));
      } else {
        staleReferences.push(stale(
          "credential_secret_refs.owner",
          `Credential references missing owner team ${secret.owner.id}`,
          `${secret.name ?? secretId} is owned by ${secret.owner.id}, but that team is not active.`,
          "Move the credential to an active team/user or restore the missing team.",
          { type: "team", id: secret.owner.id },
        ));
      }
    }
    for (const teamSlug of secret.sharedWithTeams ?? []) {
      if (!isValidOpenFgaId(teamSlug)) continue;
      if (!resourceIndex.teamSlugs.has(teamSlug)) {
        staleReferences.push(stale(
          "credential_secret_refs.sharedWithTeams",
          `Credential share references missing team ${teamSlug}`,
          `${secret.name ?? secretId} is shared with ${teamSlug}, but that team is not active.`,
          "Remove the stale share or restore the missing team.",
          { type: "team", id: teamSlug },
        ));
        continue;
      }
      tuples.push(expected("credential_secret_refs.sharedWithTeams", `team:${teamSlug}#member`, "metadata_reader", object, resource));
      tuples.push(expected("credential_secret_refs.sharedWithTeams", `team:${teamSlug}#member`, "user", object, resource));
    }
  }

  for (const share of input.sharingAccess) {
    const conversationId = share.conversation_id;
    if (!conversationId || !resourceIndex.conversationIds.has(conversationId)) {
      staleReferences.push(stale(
        "sharing_access",
        "Conversation share references missing conversation",
        `sharing_access references conversation ${conversationId ?? "(missing)"}, but the conversation was not found.`,
        "Remove the stale share row or restore the conversation.",
        conversationId ? { type: "conversation", id: conversationId } : undefined,
      ));
      continue;
    }
    const subject = resourceIndex.userSubjectsByEmail.get(String(share.granted_to ?? "").toLowerCase());
    if (!subject) {
      staleReferences.push(stale(
        "sharing_access",
        `Conversation share references unresolved user ${share.granted_to ?? "(missing)"}`,
        `The share for conversation ${conversationId} cannot be mapped to a Keycloak subject.`,
        "Relink the user or remove the stale sharing_access row.",
        { type: "user", id: String(share.granted_to ?? "") },
      ));
      continue;
    }
    tuples.push(expected("sharing_access", `user:${subject}`, "reader", `conversation:${conversationId}`));
    if (share.permission === "comment") {
      tuples.push(expected("sharing_access", `user:${subject}`, "writer", `conversation:${conversationId}`));
    }
  }

  for (const conversation of input.conversations) {
    const conversationId = String(conversation._id ?? "");
    if (!conversationId) continue;
    if (isValidOpenFgaId(conversation.created_by_service_account)) {
      tuples.push(expected(
        "conversations.created_by_service_account",
        `service_account:${conversation.created_by_service_account}`,
        "writer",
        `conversation:${conversationId}`,
      ));
    }
    const teamPermissions = conversation.sharing?.team_permissions ?? {};
    for (const teamSlug of conversation.sharing?.shared_with_teams ?? []) {
      if (!isValidOpenFgaId(teamSlug)) continue;
      if (!resourceIndex.teamSlugs.has(teamSlug)) {
        staleReferences.push(stale(
          "conversations.sharing.shared_with_teams",
          `Conversation share references missing team ${teamSlug}`,
          `Conversation ${conversationId} is shared with ${teamSlug}, but that team is not active.`,
          "Remove the stale team share or restore the missing team.",
          { type: "team", id: teamSlug },
        ));
        continue;
      }
      tuples.push(expected("conversations.sharing.shared_with_teams", `team:${teamSlug}#member`, "reader", `conversation:${conversationId}`));
      if (teamPermissions[teamSlug] === "comment") {
        tuples.push(expected("conversations.sharing.shared_with_teams", `team:${teamSlug}#member`, "writer", `conversation:${conversationId}`));
      }
    }
  }

  return { tuples: uniqueTuples(tuples), staleReferences };
}

function findingId(prefix: string, value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return `${prefix}-${hash.toString(16)}`;
}

function missingTupleFinding(tuple: ExpectedTuple): RbacSelfCheckFinding {
  const text = `${tuple.user} ${tuple.relation} ${tuple.object}`;
  return {
    id: findingId("missing", `${tuple.source}:${text}`),
    severity: "missing",
    source: tuple.source,
    title: `Missing ${tuple.source.replace(/_/g, " ")} tuple`,
    detail: text,
    fix: repairGuidance(tuple.source),
    tuple: {
      user: tuple.user,
      relation: tuple.relation,
      object: tuple.object,
    },
    repairable: true,
    ...(tuple.resource ? { resource: tuple.resource } : {}),
  };
}

function staleReferenceFinding(reference: StaleReference): RbacSelfCheckFinding {
  return {
    id: findingId("stale", `${reference.source}:${reference.title}:${reference.detail}`),
    severity: "stale_reference",
    source: reference.source,
    title: reference.title,
    detail: reference.detail,
    fix: reference.fix,
    repairable: false,
    ...(reference.resource ? { resource: reference.resource } : {}),
  };
}

function tupleText(tuple: RbacSelfCheckTuple): string {
  return `${tuple.user} ${tuple.relation} ${tuple.object}`;
}

function parseObjectRef(object: string): { type: string; id: string } {
  const separator = object.indexOf(":");
  if (separator < 0) return { type: "unknown", id: object };
  return { type: object.slice(0, separator), id: object.slice(separator + 1) };
}

function decodeOpenFgaObjectId(type: string, id: string): string {
  if (type !== "llm_model" || !id.startsWith("b64_")) return id;
  try {
    return Buffer.from(id.slice("b64_".length), "base64url").toString("utf8");
  } catch {
    return id;
  }
}

function teamSlugFromUserset(user: string): string | null {
  const match = /^team:([^#]+)#(?:member|admin|owner)$/.exec(user);
  return match?.[1] ?? null;
}

/**
 * True when `tuple` grants a resource THROUGH an archived team's userset —
 * i.e. its subject is `team:<archived-slug>#member|admin|owner`. Archiving a
 * team strips exactly these tuples (see archived-team-grants.ts), so the
 * self-check must (1) drop them from the expected set — otherwise "repair
 * missing tuples" would immediately rewrite what archival just removed — and
 * (2) flag any that still linger in OpenFGA as revocable orphan candidates.
 *
 * The team-as-OBJECT roster (`user:<sub> member team:<archived-slug>`) is NOT
 * matched here: that membership is intentionally kept so un-archiving can
 * replay grants, so it stays an expected tuple.
 */
function isArchivedTeamGrant(tuple: RbacSelfCheckTuple, archivedTeamSlugs: Set<string>): boolean {
  const slug = teamSlugFromUserset(tuple.user);
  return slug !== null && archivedTeamSlugs.has(slug);
}

function directTeamMembershipTuple(tuple: RbacSelfCheckTuple): { subject: string; teamSlug: string } | null {
  const userMatch = /^user:([^#]+)$/.exec(tuple.user);
  const objectMatch = /^team:([^#]+)$/.exec(tuple.object);
  if (!userMatch || !objectMatch) return null;
  if (tuple.relation !== "member" && tuple.relation !== "admin") return null;
  return { subject: userMatch[1], teamSlug: objectMatch[1] };
}

function revokeReviewAction(reason: string): NonNullable<RbacSelfCheckFinding["review_action"]> {
  return {
    type: "revoke_tuple",
    label: "Revoke tuple",
    reason,
  };
}

function orphanCandidateFinding(tuple: RbacSelfCheckTuple, resourceIndex: ResourceIndex): RbacSelfCheckFinding {
  const text = tupleText(tuple);
  const objectRef = parseObjectRef(tuple.object);
  const decodedObjectId = decodeOpenFgaObjectId(objectRef.type, objectRef.id);
  const teamMembership = directTeamMembershipTuple(tuple);

  if (teamMembership && !resourceIndex.teamSlugs.has(teamMembership.teamSlug)) {
    const generatedHint = teamMembership.teamSlug.startsWith("rbac-")
      ? " This looks like a generated RBAC test team."
      : "";
    return {
      id: findingId("orphan", text),
      severity: "orphan_candidate",
      source: "openfga",
      title: "Stale deleted-team membership tuple",
      detail: `${text}. Team ${teamMembership.teamSlug} is not active in Mongo.${generatedHint}`,
      fix: "Revoke this tuple to remove the dangling team membership. If the team should still exist, restore the team and its team_membership_sources row instead.",
      tuple,
      repairable: false,
      review_action: revokeReviewAction("The target team is not active in Mongo."),
      resource: { type: "team", id: teamMembership.teamSlug },
    };
  }

  if (teamMembership) {
    return {
      id: findingId("orphan", text),
      severity: "orphan_candidate",
      source: "openfga",
      title: "Unowned team membership tuple",
      detail: `${text}. The team exists, but team_membership_sources has no active row for this membership.`,
      fix: "Revoke this tuple if the user should not belong to the team. If the membership is intentional, add or repair the team_membership_sources row so it becomes source-of-truth owned.",
      tuple,
      repairable: false,
      review_action: revokeReviewAction("No active team_membership_sources row owns this membership."),
      resource: { type: "team", id: teamMembership.teamSlug },
    };
  }

  if (objectRef.type === "agent" && !resourceIndex.agentIds.has(objectRef.id)) {
    return {
      id: findingId("orphan", text),
      severity: "orphan_candidate",
      source: "openfga",
      title: "Stale deleted-agent access tuple",
      detail: `${text}. The target agent is no longer present in dynamic_agents.`,
      fix: "Revoke this tuple if the agent was removed intentionally. Restore the agent first if this access should still exist.",
      tuple,
      repairable: false,
      review_action: revokeReviewAction("The target agent is no longer present in Mongo."),
      resource: { type: "agent", id: objectRef.id },
    };
  }

  if (objectRef.type === "llm_model" && !resourceIndex.llmModelIds.has(decodedObjectId)) {
    return {
      id: findingId("orphan", text),
      severity: "orphan_candidate",
      source: "openfga",
      title: "Stale LLM model access tuple",
      detail: `${text}. Decoded model id: ${decodedObjectId}`,
      fix: "This model is not present in llm_models. Revoke the tuple if the model was removed intentionally and no rollback depends on this grant.",
      tuple,
      repairable: false,
      review_action: revokeReviewAction("The target LLM model is no longer present in Mongo."),
      resource: { type: "llm_model", id: decodedObjectId },
    };
  }

  const teamSlug = teamSlugFromUserset(tuple.user);

  // A grant flowing through an archived team's userset should not exist —
  // archival strips these. If one lingers, it's still granting access
  // (OpenFGA never checks team.status), so surface it as revocable. This is
  // the self-check's safety net for the archive-time strip.
  if (teamSlug && resourceIndex.archivedTeamSlugs.has(teamSlug)) {
    return {
      id: findingId("orphan", text),
      severity: "orphan_candidate",
      source: "openfga",
      title: "Archived-team resource grant",
      detail: `${text}. Team ${teamSlug} is archived, so it must not grant any resource access.`,
      fix: "Revoke this tuple so the archived team stops granting access. Un-archive the team first if this grant should be restored.",
      tuple,
      repairable: false,
      review_action: revokeReviewAction("The granting team is archived and must not confer access."),
      resource: { type: "team", id: teamSlug },
    };
  }

  const activeAgentAccess = resourceIndex.agentAccessByObject.get(tuple.object);
  if (objectRef.type === "agent" && teamSlug && activeAgentAccess?.visibility === "global") {
    const agentLabel = activeAgentAccess.label ?? objectRef.id;
    return {
      id: findingId("orphan", text),
      severity: "orphan_candidate",
      source: "openfga",
      title: "Redundant global-agent team grant",
      detail: `${text}. ${agentLabel} is global, so user:* user ${tuple.object} is the current source-of-truth grant.`,
      fix: "Revoke this team-specific tuple unless it was intentionally kept for backwards compatibility. The global agent grant remains in place.",
      tuple,
      repairable: false,
      review_action: revokeReviewAction("The agent is global; current source of truth does not include team-specific grants."),
      resource: { type: "agent", id: objectRef.id, ...(activeAgentAccess.label ? { label: activeAgentAccess.label } : {}) },
    };
  }

  if (objectRef.type === "agent" && teamSlug && activeAgentAccess && !activeAgentAccess.teamSlugs.has(teamSlug)) {
    const currentTeams = Array.from(activeAgentAccess.teamSlugs).sort().join(", ") || "no owner/shared team";
    return {
      id: findingId("orphan", text),
      severity: "orphan_candidate",
      source: "openfga",
      title: "Stale agent team grant",
      detail: `${text}. Current agent team${activeAgentAccess.teamSlugs.size === 1 ? "" : "s"}: ${currentTeams}`,
      fix: "Either add this team back to the agent owner/share settings, or revoke the tuple so the old team no longer gets access.",
      tuple,
      repairable: false,
      review_action: revokeReviewAction("The current agent owner/share settings do not include this team."),
      resource: { type: "agent", id: objectRef.id, ...(activeAgentAccess.label ? { label: activeAgentAccess.label } : {}) },
    };
  }

  const activeMcpServer = resourceIndex.mcpServersByObject.get(tuple.object);
  if (
    objectRef.type === "mcp_server" &&
    activeMcpServer &&
    !activeMcpServer.configDriven &&
    tuple.user === `${organizationObjectId()}#member` &&
    ["reader", "user", "invoker"].includes(tuple.relation)
  ) {
    const serverLabel = activeMcpServer.label ?? objectRef.id;
    return {
      id: findingId("orphan", text),
      severity: "orphan_candidate",
      source: "openfga",
      title: "Legacy organization-wide MCP grant",
      detail: `${text}. ${serverLabel} is a user-created MCP server; current source of truth grants owner/team access plus org-admin management, not organization-wide member access.`,
      fix: "Revoke this tuple if the server should remain private/team-scoped. If every org member should see and use it, convert the MCP server to config-driven/default visibility instead of keeping an unowned tuple.",
      tuple,
      repairable: false,
      review_action: revokeReviewAction("The MCP server source record does not grant organization-wide member access."),
      resource: { type: "mcp_server", id: objectRef.id, ...(activeMcpServer.label ? { label: activeMcpServer.label } : {}) },
    };
  }

  const activeSlackTeams = resourceIndex.slackChannelTeamsByObject.get(tuple.object);
  if (objectRef.type === "slack_channel" && teamSlug && activeSlackTeams && !activeSlackTeams.has(teamSlug)) {
    const currentTeams = Array.from(activeSlackTeams).sort().join(", ");
    return {
      id: findingId("orphan", text),
      severity: "orphan_candidate",
      source: "openfga",
      title: "Stale Slack channel team grant",
      detail: `${text}. Current mapped team${activeSlackTeams.size === 1 ? "" : "s"}: ${currentTeams}`,
      fix: "The channel-team mapping changed. Revoke this tuple if the old team should no longer manage or use the Slack channel.",
      tuple,
      repairable: false,
      review_action: revokeReviewAction("The current Slack channel mapping does not include this team."),
      resource: { type: "slack_channel", id: objectRef.id },
    };
  }

  const activeWebexTeams = resourceIndex.webexSpaceTeamsByObject.get(tuple.object);
  if (objectRef.type === "webex_space" && teamSlug && activeWebexTeams && !activeWebexTeams.has(teamSlug)) {
    const currentTeams = Array.from(activeWebexTeams).sort().join(", ");
    return {
      id: findingId("orphan", text),
      severity: "orphan_candidate",
      source: "openfga",
      title: "Stale Webex space team grant",
      detail: `${text}. Current mapped team${activeWebexTeams.size === 1 ? "" : "s"}: ${currentTeams}`,
      fix: "The space-team mapping changed. Revoke this tuple if the old team should no longer manage or use the Webex space.",
      tuple,
      repairable: false,
      review_action: revokeReviewAction("The current Webex space mapping does not include this team."),
      resource: { type: "webex_space", id: objectRef.id },
    };
  }

  return {
    id: findingId("orphan", text),
    severity: "orphan_candidate",
    source: "openfga",
    title: "Unowned tuple",
    detail: text,
    fix: "Review before revoking. This tuple may come from bootstrap, a migration, manual admin action, or an older feature path not covered by the source-of-truth audit.",
    tuple,
    repairable: false,
    review_action: revokeReviewAction("No current source-of-truth record in this audit owns the tuple."),
  };
}

function repairGuidance(source: string): string {
  if (source.startsWith("dynamic_agents")) return "Replay agent reconciliation; this writes owner/team/global grants and agent-to-tool caller tuples.";
  if (source.startsWith("service_accounts")) return "Repair service account ownership/scopes from the service account source record.";
  if (source.startsWith("team_membership")) return "Repair the active team membership source into OpenFGA.";
  if (source.startsWith("slack") || source.startsWith("channel_team")) return "Re-sync Slack channel/team grants from the integration source records.";
  if (source.startsWith("webex")) return "Re-sync Webex space/team grants from the integration source records.";
  if (source.startsWith("credential")) return "Replay credential owner/share reconciliation.";
  if (source.startsWith("sharing") || source.startsWith("conversations")) return "Replay conversation share reconciliation.";
  if (source.startsWith("mcp_servers")) return "Replay MCP server ownership and config-driven visibility reconciliation.";
  if (source.startsWith("llm_models")) return "Replay LLM model visibility reconciliation.";
  if (source.startsWith("super_admins")) return "Run the super-admins bootstrap repair.";
  if (source.startsWith("platform_config")) return "Re-save platform settings or replay login bootstrap for the configured default agent.";
  if (source.startsWith("baseline_access")) return "Replay login/OpenFGA baseline bootstrap for platform access grants.";
  return "Write the listed base tuple after validating that the source record still exists.";
}

function buildRepairBatches(findings: RbacSelfCheckFinding[]): RbacSelfCheckRepairBatch[] {
  const bySource = new Map<string, RbacSelfCheckFinding[]>();
  for (const finding of findings) {
    if (finding.severity !== "missing") continue;
    const rows = bySource.get(finding.source) ?? [];
    rows.push(finding);
    bySource.set(finding.source, rows);
  }
  return Array.from(bySource.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([source, rows]) => ({
      source,
      finding_count: rows.length,
      repairable_count: rows.filter((finding) => finding.repairable).length,
      action_label: source.includes(".") ? source.split(".")[0].replace(/_/g, " ") : source.replace(/_/g, " "),
      guidance: repairGuidance(source),
    }));
}

function objectType(object: string): string {
  return object.split(":")[0] || "unknown";
}

function countBy<T>(items: T[], keyFn: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) increment(counts, keyFn(item));
  return sortedRecord(counts);
}

function managedObjectTuple(tuple: RbacSelfCheckTuple): boolean {
  return [
    "agent:",
    "mcp_server:",
    "llm_model:",
    "service_account:",
    "slack_channel:",
    "webex_space:",
    "secret_ref:",
    "conversation:",
    "team:",
    "tool:",
    "mcp_gateway:",
    "organization:",
  ].some((prefix) => tuple.object.startsWith(prefix));
}

function sourceInScope(source: string, scope: ResolvedSelfCheckScope): boolean {
  return scope.all || scope.sourceSet.has(source);
}

function orphanObjectInScope(tuple: RbacSelfCheckTuple, scope: ResolvedSelfCheckScope): boolean {
  return scope.all || scope.orphanObjectTypeSet.has(objectType(tuple.object));
}

export function deriveRbacSelfCheckReport(
  input: RbacSelfCheckInventoryInput,
  options: RbacSelfCheckOptions = {},
): RbacSelfCheckReport {
  const maxFindings = options.maxFindings ?? MAX_FINDINGS;
  const orphanCandidateLimit = options.orphanCandidateLimit ?? ORPHAN_CANDIDATE_LIMIT;
  const scope = resolveSelfCheckScope(options.checks);
  const resourceIndex = buildResourceIndex(input);
  const actualTuples = uniqueTuples(input.actualTuples);
  const actualKeys = new Set(actualTuples.map(tupleKey));
  const { tuples: sourceExpectedTuples, staleReferences: allStaleReferences } = buildExpectedTuplesAndStaleReferences(input, resourceIndex);
  const allExpectedTuples = uniqueTuples([
    ...sourceExpectedTuples,
    ...currentBaselineAccessTuples(input, actualKeys),
  ])
    // Archived teams grant nothing: drop any expected grant flowing through an
    // archived team's `#member`/`#admin`/`#owner` userset. Keeping these would
    // (a) report them as `missing` (archival stripped them) and (b) let the
    // repair action rewrite the very tuples archival removed. The team-as-object
    // roster is untouched, so membership stays expected and is not flagged.
    .filter((tuple) => !isArchivedTeamGrant(tuple, resourceIndex.archivedTeamSlugs));
  const expectedTuples = allExpectedTuples.filter((tuple) => sourceInScope(tuple.source, scope));
  const staleReferences = allStaleReferences.filter((reference) => sourceInScope(reference.source, scope));
  const allExpectedKeys = new Set(allExpectedTuples.map(tupleKey));
  const missingTuples = expectedTuples.filter((tuple) => !actualKeys.has(tupleKey(tuple)));
  const allOrphanCandidates = actualTuples
    .filter((tuple) => managedObjectTuple(tuple) && orphanObjectInScope(tuple, scope) && !allExpectedKeys.has(tupleKey(tuple)));
  const orphanCandidates = allOrphanCandidates.slice(0, orphanCandidateLimit);

  const missingFindings = missingTuples.map(missingTupleFinding);
  const staleFindings = staleReferences.map(staleReferenceFinding);
  const orphanFindings = orphanCandidates.map((tuple) => orphanCandidateFinding(tuple, resourceIndex));
  const findings = [...missingFindings, ...staleFindings, ...orphanFindings].slice(0, maxFindings);

  const missingBySource = countBy(missingTuples, (tuple) => tuple.source);
  const staleCount = staleReferences.length;
  const status = missingTuples.length > 0 ? "fail" : staleCount > 0 || allOrphanCandidates.length > 0 ? "warn" : "pass";

  const mongoInventory = {
    teams: input.teams.length,
    active_membership_sources_with_subject: input.teamMembershipSources.length,
    dynamic_agents: input.dynamicAgents.length,
    mcp_servers: input.mcpServers.length,
    llm_models: input.llmModels.length,
    service_accounts: input.serviceAccounts.length,
    slack_channel_grants: input.slackChannelGrants.length,
    slack_channel_team_mappings: input.slackChannelTeamMappings.length,
    webex_space_grants: input.webexSpaceGrants.length,
    webex_space_team_mappings: input.webexSpaceTeamMappings.length,
    credential_secret_refs: input.credentialSecretRefs.length,
    conversations: input.conversations.length,
    sharing_access: input.sharingAccess.length,
    skills: input.skills.length,
    tasks: input.tasks.length,
    mcp_tool_catalog: input.mcpToolCatalog.length,
  };

  return {
    generated_at: input.generatedAt ?? new Date().toISOString(),
    status,
    scope: {
      selected: scope.selected,
      labels: scope.labels,
      all: scope.all,
    },
    inventory: {
      mongo: mongoInventory,
      openfga_tuple_count: actualTuples.length,
      openfga_tuples_by_object_type: countBy(actualTuples, (tuple) => objectType(tuple.object)),
      organization_capability_tuples: actualTuples
        .filter((tuple) => tuple.object === organizationObjectId())
        .map((tuple) => `${tuple.user} ${tuple.relation} ${tuple.object}`)
        .sort(),
    },
    summary: {
      expected_tuples: expectedTuples.length,
      missing_tuples: missingTuples.length,
      stale_references: staleCount,
      orphan_candidates: allOrphanCandidates.length,
      repairable_findings: missingFindings.filter((finding) => finding.repairable).length,
      total_findings: missingFindings.length + staleFindings.length + allOrphanCandidates.length,
    },
    expected_by_source: countBy(expectedTuples, (tuple) => tuple.source),
    missing_by_source: missingBySource,
    findings,
    repair_batches: buildRepairBatches(missingFindings),
    notes: [
      `Self-check scope: ${scope.all ? "all checks" : scope.labels.join(", ")}.`,
      "Repair writes only base tuples such as user, caller, reader, manager, owner, owner_team, and writer.",
      "Stale references are not repaired automatically because writing tuples would resurrect access to deleted or missing resources.",
      "Unowned tuples are advisory; review before revoking because older migrations, bootstrap flows, or manual admin actions may intentionally own them.",
      "Revoking an unowned tuple removes that exact grant only; effective access can remain through global user:* grants, org admin grants, direct user/service-account grants, or another team path.",
      ...(allOrphanCandidates.length > orphanCandidates.length
        ? [`Showing the first ${orphanCandidates.length} of ${allOrphanCandidates.length} unowned tuples. Re-run after cleanup to reveal the next batch.`]
        : []),
      "Org feature capabilities such as organization#searcher and organization#ingestor are reported as current OpenFGA state, not inferred from Mongo.",
    ],
  };
}

async function loadCollection<T extends Document>(collectionName: string, filter: Filter<T> = {}): Promise<T[]> {
  const collection = await getCollection<T>(collectionName);
  return (await collection.find(filter).toArray()) as T[];
}

async function readAllOpenFgaTuples(): Promise<RbacSelfCheckTuple[]> {
  const tuples: RbacSelfCheckTuple[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await readOpenFgaTuples({ continuationToken, pageSize: 100 });
    tuples.push(
      ...page.tuples.map((tuple: OpenFgaTuple) => ({
        user: tuple.key.user,
        relation: tuple.key.relation,
        object: tuple.key.object,
      })),
    );
    continuationToken = page.continuationToken;
  } while (continuationToken);
  return tuples;
}

export async function runRbacSelfCheck(options: RbacSelfCheckOptions = {}): Promise<RbacSelfCheckReport> {
  const [
    actualTuples,
    teams,
    teamMembershipSources,
    dynamicAgents,
    mcpServers,
    llmModels,
    serviceAccounts,
    slackChannelGrants,
    slackChannelTeamMappings,
    webexSpaceGrants,
    webexSpaceTeamMappings,
    credentialSecretRefs,
    users,
    sharingAccess,
    conversations,
    skills,
    tasks,
    mcpToolCatalog,
    platformConfigRows,
    baselineProfile,
  ] = await Promise.all([
    readAllOpenFgaTuples(),
    loadCollection<TeamDoc>("teams", { status: { $ne: "deleted" } }),
    loadCollection<TeamMembershipSourceDoc>("team_membership_sources", {
      status: "active",
      user_subject: { $exists: true, $ne: null },
    }),
    loadCollection<DynamicAgentDoc>("dynamic_agents", {
      deleted_at: { $exists: false },
      status: { $ne: "deleted" },
    }),
    loadCollection<McpServerDoc>("mcp_servers", {
      enabled: { $ne: false },
      status: { $ne: "deleted" },
    }),
    loadCollection<LlmModelDoc>("llm_models", { status: { $ne: "deleted" } }),
    loadCollection<ServiceAccountDoc>("service_accounts", { status: "active" }),
    loadCollection<MessagingGrantDoc>("slack_channel_grants", { status: "active" }),
    loadCollection<SlackTeamMappingDoc>("channel_team_mappings", { active: { $ne: false } }),
    loadCollection<MessagingGrantDoc>("webex_space_grants", { status: "active" }),
    loadCollection<WebexTeamMappingDoc>("webex_space_team_mappings", { active: { $ne: false } }),
    loadCollection<CredentialSecretRefDoc>("credential_secret_refs"),
    loadCollection<UserDoc>("users"),
    loadCollection<SharingAccessDoc>("sharing_access"),
    loadCollection<ConversationDoc>("conversations"),
    loadCollection<SkillDoc>("agent_skills"),
    loadCollection<TaskDoc>("task_configs"),
    loadCollection<ToolCatalogDoc>("mcp_tool_catalog"),
    loadCollection<PlatformConfigDoc>("platform_config", { _id: "platform_settings" } as unknown as Filter<PlatformConfigDoc>),
    getBaselineFgaProfile(),
  ]);

  return deriveRbacSelfCheckReport(
    {
      actualTuples,
      teams,
      teamMembershipSources,
      dynamicAgents,
      mcpServers,
      llmModels,
      serviceAccounts,
      slackChannelGrants,
      slackChannelTeamMappings,
      webexSpaceGrants,
      webexSpaceTeamMappings,
      credentialSecretRefs,
      users,
      sharingAccess,
      conversations,
      skills,
      tasks,
      mcpToolCatalog,
      platformConfig: platformConfigRows[0] ?? null,
      baselineProfile,
    },
    options,
  );
}

export function repairableMissingTuples(report: RbacSelfCheckReport, sources?: string[]): OpenFgaTupleKey[] {
  const sourceFilter = sources && sources.length > 0 ? new Set(sources) : null;
  return uniqueTuples(
    report.findings
      .filter((finding) => finding.severity === "missing" && finding.repairable && finding.tuple)
      .filter((finding) => !sourceFilter || sourceFilter.has(finding.source))
      .map((finding) => finding.tuple!)
  );
}
