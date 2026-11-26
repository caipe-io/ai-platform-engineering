import { getCollection } from "@/lib/mongodb";
import type { OpenFgaTupleKey } from "@/lib/rbac/openfga";
import { organizationObjectId } from "@/lib/rbac/organization";

export const BASELINE_ADMIN_SURFACES = [
  "users",
  "teams",
  "skills",
  "slack",
  "webex",
  "feedback",
  "stats",
  "health",
  "credentials",
] as const;
export const PRIVILEGED_ADMIN_SURFACES = [
  "roles",
  "identity_group_sync",
  "metrics",
  "audit_logs",
  "action_audit",
  "openfga",
  "migrations",
  // RAG / Knowledge Bases admin surface. The `rag` short-circuit in
  // `api-middleware.ts` already maps `rag` + `admin` →
  // `admin_surface:rag_datasources#can_manage`; seeding it explicitly via
  // the admin baseline grants makes the org-admin super-grant on KB /
  // Search / Data Sources / Graph / MCP Tools fail-safe instead of
  // relying on the (otherwise reliable) model inheritance from
  // `organization#admin`.
  "rag_datasources",
] as const;

export type BaselineAdminSurface = (typeof BASELINE_ADMIN_SURFACES)[number];
export type PrivilegedAdminSurface = (typeof PRIVILEGED_ADMIN_SURFACES)[number];
export type AdminSurface = BaselineAdminSurface | PrivilegedAdminSurface;

export interface BaselineDiagnosticCheck {
  id: string;
  label: string;
  tuple: OpenFgaTupleKey;
  expected_member: boolean;
  expected_admin: boolean;
}

export interface BaselineFgaGrantDefinition {
  id: string;
  label: string;
  description: string;
  tuple: (subject: string) => OpenFgaTupleKey;
}

export type BaselineFgaProfileRole = "member" | "admin";

export interface BaselineFgaProfileDefinition {
  id: string;
  name: string;
  description?: string;
  role: BaselineFgaProfileRole;
  grants: string[];
  built_in?: boolean;
  updated_at?: string;
  updated_by?: string;
}

export interface BaselineFgaProfile {
  member_grants: string[];
  admin_grants: string[];
  updated_at?: string;
  updated_by?: string;
  source: "default" | "mongo";
}

export interface BaselineFgaProfileBundle {
  profiles: BaselineFgaProfileDefinition[];
  global_member_profile_id: string;
  global_admin_profile_id: string;
  updated_at?: string;
  updated_by?: string;
  source: "default" | "mongo";
}

export interface TeamBaselineProfileOverride {
  team_id?: string;
  team_slug: string;
  team_name?: string;
  role: "member" | "admin" | "owner";
  member_profile_id?: string;
  admin_profile_id?: string;
}

type BaselineFgaProfileDoc = {
  _id: string;
  member_grants?: unknown;
  admin_grants?: unknown;
  profiles?: unknown;
  global_member_profile_id?: unknown;
  global_admin_profile_id?: unknown;
  updated_at?: string;
  updated_by?: string;
} & Record<string, unknown>;

export const BASELINE_FGA_PROFILE_COLLECTION = "openfga_baseline_profiles";
export const BASELINE_FGA_PROFILE_ID = "default";
export const BASELINE_FGA_PROFILE_BUNDLE_ID = "profiles_v2";
export const ORG_MEMBER_PROFILE_ID = "org-member";
export const ORG_ADMIN_PROFILE_ID = "org-admin";

export function adminSurfaceObject(surface: string): string {
  return `admin_surface:${surface}`;
}

export function userProfileObject(subject: string): string {
  return `user_profile:${subject}`;
}

export function memberBaselineGrantDefinitions(): BaselineFgaGrantDefinition[] {
  return [
    {
      id: "organization-member",
      label: "Organization member",
      description: "Allows the user to use organization-scoped CAIPE resources.",
      tuple: (subject) => ({ user: `user:${subject}`, relation: "member", object: organizationObjectId() }),
    },
    {
      id: "platform-settings-read",
      label: "Read platform settings",
      description: "Allows non-admin users to read platform settings needed by the UI.",
      tuple: (subject) => ({
        user: `user:${subject}`,
        relation: "reader",
        object: "system_config:platform_settings",
      }),
    },
    {
      id: "own-profile-owner",
      label: "Own user profile",
      description: "Allows users to read and manage their own profile object.",
      tuple: (subject) => ({ user: `user:${subject}`, relation: "owner", object: userProfileObject(subject) }),
    },
    {
      id: "mcp-gateway-call",
      label: "Call MCP gateway",
      description: "Allows admitted users to pass AgentGateway's coarse MCP ext_authz gate.",
      tuple: (subject) => ({ user: `user:${subject}`, relation: "caller", object: "mcp_gateway:list" }),
    },
    ...BASELINE_ADMIN_SURFACES.map((surface) => ({
      id: `admin-surface:${surface}:read`,
      label: `Read ${surface.replaceAll("_", " ")} admin surface`,
      description: `Shows the ${surface.replaceAll("_", " ")} admin tab in read-only mode for non-admin users.`,
      tuple: (subject: string) => ({
        user: `user:${subject}`,
        relation: "reader",
        object: adminSurfaceObject(surface),
      }),
    })),
  ];
}

export function adminBaselineGrantDefinitions(): BaselineFgaGrantDefinition[] {
  return [
    {
      id: "organization-admin",
      label: "Organization admin",
      description: "Allows the user to administer organization-scoped CAIPE resources.",
      tuple: (subject) => ({ user: `user:${subject}`, relation: "admin", object: organizationObjectId() }),
    },
    {
      id: "platform-settings-manage",
      label: "Manage platform settings",
      description: "Allows admins to update platform settings and system configuration.",
      tuple: (subject) => ({
        user: `user:${subject}`,
        relation: "manager",
        object: "system_config:platform_settings",
      }),
    },
    {
      id: "agentgateway-manage",
      label: "Manage AgentGateway MCP sync",
      description: "Allows admins to sync MCP servers through AgentGateway.",
      tuple: (subject) => ({ user: `user:${subject}`, relation: "manager", object: "mcp_server:agentgateway" }),
    },
    ...BASELINE_ADMIN_SURFACES.map((surface) => ({
      id: `admin-surface:${surface}:manage`,
      label: `Manage ${surface.replaceAll("_", " ")} admin surface`,
      description: `Allows admins to manage the ${surface.replaceAll("_", " ")} admin surface.`,
      tuple: (subject: string) => ({
        user: `user:${subject}`,
        relation: "manager",
        object: adminSurfaceObject(surface),
      }),
    })),
    ...PRIVILEGED_ADMIN_SURFACES.map((surface) => ({
      id: `admin-surface:${surface}:manage`,
      label: `Manage ${surface.replaceAll("_", " ")} admin surface`,
      description: `Allows admins to manage the ${surface.replaceAll("_", " ")} admin surface.`,
      tuple: (subject: string) => ({
        user: `user:${subject}`,
        relation: "manager",
        object: adminSurfaceObject(surface),
      }),
    })),
  ];
}

function uniqueGrantIds(values: unknown, definitions: BaselineFgaGrantDefinition[]): string[] {
  const allowed = new Set(definitions.map((definition) => definition.id));
  const ids = Array.isArray(values) ? values : definitions.map((definition) => definition.id);
  const selected: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string" || !allowed.has(id) || selected.includes(id)) continue;
    selected.push(id);
  }
  return selected;
}

export function defaultBaselineFgaProfile(): BaselineFgaProfile {
  return {
    member_grants: memberBaselineGrantDefinitions().map((definition) => definition.id),
    admin_grants: adminBaselineGrantDefinitions().map((definition) => definition.id),
    source: "default",
  };
}

function definitionsForRole(role: BaselineFgaProfileRole): BaselineFgaGrantDefinition[] {
  return role === "member" ? memberBaselineGrantDefinitions() : adminBaselineGrantDefinitions();
}

function uniqueProfileGrantIds(values: unknown, role: BaselineFgaProfileRole): string[] {
  return uniqueGrantIds(values, definitionsForRole(role));
}

function defaultProfileDefinition(role: BaselineFgaProfileRole): BaselineFgaProfileDefinition {
  const member = role === "member";
  return {
    id: member ? ORG_MEMBER_PROFILE_ID : ORG_ADMIN_PROFILE_ID,
    name: member ? "Organization member" : "Organization admin",
    description: member
      ? "Default baseline grants for authorized organization members."
      : "Default baseline grants added for organization administrators.",
    role,
    grants: definitionsForRole(role).map((definition) => definition.id),
    built_in: true,
  };
}

export function defaultBaselineFgaProfileBundle(): BaselineFgaProfileBundle {
  return {
    profiles: [defaultProfileDefinition("member"), defaultProfileDefinition("admin")],
    global_member_profile_id: ORG_MEMBER_PROFILE_ID,
    global_admin_profile_id: ORG_ADMIN_PROFILE_ID,
    source: "default",
  };
}

function isProfileRole(value: unknown): value is BaselineFgaProfileRole {
  return value === "member" || value === "admin";
}

function normalizeProfileId(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeProfileDefinition(value: unknown): BaselineFgaProfileDefinition | null {
  if (!value || typeof value !== "object") return null;
  const profile = value as Partial<BaselineFgaProfileDefinition>;
  if (!profile.id || typeof profile.id !== "string" || !isProfileRole(profile.role)) return null;
  return {
    id: profile.id.trim(),
    name: typeof profile.name === "string" && profile.name.trim() ? profile.name.trim() : profile.id.trim(),
    description: typeof profile.description === "string" ? profile.description : undefined,
    role: profile.role,
    grants: uniqueProfileGrantIds(profile.grants, profile.role),
    built_in: Boolean(profile.built_in),
    updated_at: profile.updated_at,
    updated_by: profile.updated_by,
  };
}

function mergeBuiltInProfileDefaults(
  profile: BaselineFgaProfileDefinition,
  defaults: Map<string, BaselineFgaProfileDefinition>,
): BaselineFgaProfileDefinition {
  const defaultProfile = defaults.get(profile.id);
  if (!profile.built_in || !defaultProfile || defaultProfile.role !== profile.role) {
    return profile;
  }
  return {
    ...profile,
    grants: Array.from(new Set([...defaultProfile.grants, ...profile.grants])),
  };
}

export function normalizeBaselineFgaProfileBundle(input: {
  profiles?: unknown;
  global_member_profile_id?: unknown;
  global_admin_profile_id?: unknown;
  updated_at?: string;
  updated_by?: string;
  source?: "default" | "mongo";
}): BaselineFgaProfileBundle {
  const defaults = defaultBaselineFgaProfileBundle();
  const byId = new Map(defaults.profiles.map((profile) => [profile.id, profile]));
  if (Array.isArray(input.profiles)) {
    for (const value of input.profiles) {
      const profile = normalizeProfileDefinition(value);
      if (!profile) continue;
      byId.set(profile.id, mergeBuiltInProfileDefaults(profile, byId));
    }
  }
  const profiles = Array.from(byId.values());
  const memberIds = new Set(profiles.filter((profile) => profile.role === "member").map((profile) => profile.id));
  const adminIds = new Set(profiles.filter((profile) => profile.role === "admin").map((profile) => profile.id));
  const globalMemberId = normalizeProfileId(input.global_member_profile_id, ORG_MEMBER_PROFILE_ID);
  const globalAdminId = normalizeProfileId(input.global_admin_profile_id, ORG_ADMIN_PROFILE_ID);
  return {
    profiles,
    global_member_profile_id: memberIds.has(globalMemberId) ? globalMemberId : ORG_MEMBER_PROFILE_ID,
    global_admin_profile_id: adminIds.has(globalAdminId) ? globalAdminId : ORG_ADMIN_PROFILE_ID,
    updated_at: input.updated_at,
    updated_by: input.updated_by,
    source: input.source ?? "default",
  };
}

export function normalizeBaselineFgaProfile(input: {
  member_grants?: unknown;
  admin_grants?: unknown;
  updated_at?: string;
  updated_by?: string;
  source?: "default" | "mongo";
}): BaselineFgaProfile {
  return {
    member_grants: uniqueGrantIds(input.member_grants, memberBaselineGrantDefinitions()),
    admin_grants: uniqueGrantIds(input.admin_grants, adminBaselineGrantDefinitions()),
    updated_at: input.updated_at,
    updated_by: input.updated_by,
    source: input.source ?? "default",
  };
}

function legacyProfileToBundle(profile: BaselineFgaProfile): BaselineFgaProfileBundle {
  return normalizeBaselineFgaProfileBundle({
    profiles: [
      { ...defaultProfileDefinition("member"), grants: profile.member_grants },
      { ...defaultProfileDefinition("admin"), grants: profile.admin_grants },
    ],
    global_member_profile_id: ORG_MEMBER_PROFILE_ID,
    global_admin_profile_id: ORG_ADMIN_PROFILE_ID,
    updated_at: profile.updated_at,
    updated_by: profile.updated_by,
    source: profile.source,
  });
}

export function bundleToLegacyProfile(bundle: BaselineFgaProfileBundle): BaselineFgaProfile {
  const memberProfile = profileForId(bundle, "member", bundle.global_member_profile_id);
  const adminProfile = profileForId(bundle, "admin", bundle.global_admin_profile_id);
  return {
    member_grants: memberProfile.grants,
    admin_grants: adminProfile.grants,
    updated_at: bundle.updated_at,
    updated_by: bundle.updated_by,
    source: bundle.source,
  };
}

/**
 * Read the stored profile bundle; a read error throws instead of falling back to defaults.
 * `strictGlobalMemberProfile` also throws when the stored global member profile id
 * names no member profile, instead of normalizing it to `org-member`.
 */
export async function readBaselineFgaProfileBundle(
  options: { strictGlobalMemberProfile?: boolean } = {}
): Promise<BaselineFgaProfileBundle> {
  const collection = await getCollection<BaselineFgaProfileDoc>(BASELINE_FGA_PROFILE_COLLECTION);
  const doc = await collection.findOne({ _id: BASELINE_FGA_PROFILE_BUNDLE_ID });
  if (doc) {
    const bundle = normalizeBaselineFgaProfileBundle({ ...doc, source: "mongo" });
    const configuredId = doc.global_member_profile_id;
    if (options.strictGlobalMemberProfile && configuredId !== undefined && configuredId !== null) {
      const id = typeof configuredId === "string" ? configuredId.trim() : "";
      if (!bundle.profiles.some((profile) => profile.role === "member" && profile.id === id)) {
        throw new Error("configured global member profile is not defined");
      }
    }
    return bundle;
  }
  const legacy = await collection.findOne({ _id: BASELINE_FGA_PROFILE_ID });
  if (legacy) return legacyProfileToBundle(normalizeBaselineFgaProfile({ ...legacy, source: "mongo" }));
  return defaultBaselineFgaProfileBundle();
}

export async function getBaselineFgaProfileBundle(): Promise<BaselineFgaProfileBundle> {
  try {
    return await readBaselineFgaProfileBundle();
  } catch {
    return defaultBaselineFgaProfileBundle();
  }
}

export async function getBaselineFgaProfile(): Promise<BaselineFgaProfile> {
  try {
    return bundleToLegacyProfile(await getBaselineFgaProfileBundle());
  } catch {
    return defaultBaselineFgaProfile();
  }
}

export async function saveBaselineFgaProfileBundle(input: {
  profiles: BaselineFgaProfileDefinition[];
  global_member_profile_id: string;
  global_admin_profile_id: string;
  updated_by: string;
}): Promise<BaselineFgaProfileBundle> {
  const bundle = normalizeBaselineFgaProfileBundle({
    profiles: input.profiles,
    global_member_profile_id: input.global_member_profile_id,
    global_admin_profile_id: input.global_admin_profile_id,
    updated_at: new Date().toISOString(),
    updated_by: input.updated_by,
    source: "mongo",
  });
  const collection = await getCollection<BaselineFgaProfileDoc>(BASELINE_FGA_PROFILE_COLLECTION);
  await collection.updateOne(
    { _id: BASELINE_FGA_PROFILE_BUNDLE_ID },
    {
      $set: {
        profiles: bundle.profiles,
        global_member_profile_id: bundle.global_member_profile_id,
        global_admin_profile_id: bundle.global_admin_profile_id,
        updated_at: bundle.updated_at,
        updated_by: bundle.updated_by,
      },
      $setOnInsert: { _id: BASELINE_FGA_PROFILE_BUNDLE_ID },
    },
    { upsert: true },
  );
  return bundle;
}

export async function saveBaselineFgaProfile(input: {
  member_grants: string[];
  admin_grants: string[];
  updated_by: string;
}): Promise<BaselineFgaProfile> {
  const profile = normalizeBaselineFgaProfile({
    member_grants: input.member_grants,
    admin_grants: input.admin_grants,
    updated_at: new Date().toISOString(),
    updated_by: input.updated_by,
    source: "mongo",
  });
  const collection = await getCollection<BaselineFgaProfileDoc>(BASELINE_FGA_PROFILE_COLLECTION);
  await collection.updateOne(
    { _id: BASELINE_FGA_PROFILE_ID },
    {
      $set: {
        member_grants: profile.member_grants,
        admin_grants: profile.admin_grants,
        updated_at: profile.updated_at,
        updated_by: profile.updated_by,
      },
      $setOnInsert: { _id: BASELINE_FGA_PROFILE_ID },
    },
    { upsert: true },
  );
  return profile;
}

function tuplesFromGrantIds(
  subject: string,
  grantIds: string[],
  definitions: BaselineFgaGrantDefinition[],
): OpenFgaTupleKey[] {
  const selected = new Set(grantIds);
  return definitions
    .filter((definition) => selected.has(definition.id))
    .map((definition) => definition.tuple(subject));
}

export function baselineMemberTuples(
  subject: string,
  profile: BaselineFgaProfile = defaultBaselineFgaProfile(),
): OpenFgaTupleKey[] {
  return tuplesFromGrantIds(subject, profile.member_grants, memberBaselineGrantDefinitions());
}

export function baselineAdminTuples(
  subject: string,
  profile: BaselineFgaProfile = defaultBaselineFgaProfile(),
): OpenFgaTupleKey[] {
  return tuplesFromGrantIds(subject, profile.admin_grants, adminBaselineGrantDefinitions());
}

export function baselineBootstrapTuples(
  subject: string,
  isAdmin: boolean,
  profile: BaselineFgaProfile = defaultBaselineFgaProfile(),
): OpenFgaTupleKey[] {
  const memberTuples = baselineMemberTuples(subject, profile);
  return isAdmin ? [...memberTuples, ...baselineAdminTuples(subject, profile)] : memberTuples;
}

function profileForId(
  bundle: BaselineFgaProfileBundle,
  role: BaselineFgaProfileRole,
  profileId: string,
): BaselineFgaProfileDefinition {
  const fallback = defaultProfileDefinition(role);
  return bundle.profiles.find((profile) => profile.role === role && profile.id === profileId) ?? fallback;
}

function uniqueProfileIds(values: Array<string | undefined>): string[] {
  const selected: string[] = [];
  for (const value of values) {
    const id = value?.trim();
    if (!id || selected.includes(id)) continue;
    selected.push(id);
  }
  return selected;
}

function grantIdsFromProfiles(
  bundle: BaselineFgaProfileBundle,
  role: BaselineFgaProfileRole,
  profileIds: string[],
): string[] {
  const grants: string[] = [];
  for (const profileId of profileIds) {
    const profile = profileForId(bundle, role, profileId);
    for (const grant of profile.grants) {
      if (!grants.includes(grant)) grants.push(grant);
    }
  }
  return grants;
}

export function effectiveBaselineBootstrapTuples(input: {
  subject: string;
  isAdmin: boolean;
  bundle?: BaselineFgaProfileBundle;
  teamOverrides?: TeamBaselineProfileOverride[];
}): OpenFgaTupleKey[] {
  const bundle = input.bundle ?? defaultBaselineFgaProfileBundle();
  const memberOverrideProfileIds = uniqueProfileIds(
    (input.teamOverrides ?? []).map((override) => override.member_profile_id),
  );
  const memberProfileIds =
    memberOverrideProfileIds.length > 0 ? memberOverrideProfileIds : [bundle.global_member_profile_id];
  const memberGrants = grantIdsFromProfiles(bundle, "member", memberProfileIds);
  const tuples = tuplesFromGrantIds(input.subject, memberGrants, memberBaselineGrantDefinitions());

  if (input.isAdmin) {
    const adminOverrideProfileIds = uniqueProfileIds(
      (input.teamOverrides ?? [])
        .filter((override) => override.role === "admin" || override.role === "owner")
        .map((override) => override.admin_profile_id),
    );
    const adminProfileIds =
      adminOverrideProfileIds.length > 0 ? adminOverrideProfileIds : [bundle.global_admin_profile_id];
    tuples.push(...tuplesFromGrantIds(input.subject, grantIdsFromProfiles(bundle, "admin", adminProfileIds), adminBaselineGrantDefinitions()));
  }

  return tuples;
}

export function baselineDiagnosticChecks(
  subject: string,
  profile: BaselineFgaProfile = defaultBaselineFgaProfile(),
): BaselineDiagnosticCheck[] {
  return [
    ...memberBaselineGrantDefinitions().map((definition) => {
      const selected = profile.member_grants.includes(definition.id);
      return {
        id: `member-${definition.id}`,
        label: definition.label,
        tuple: materializedDiagnosticTuple(definition.tuple(subject)),
        expected_member: selected,
        expected_admin: selected,
      };
    }),
    ...adminBaselineGrantDefinitions().map((definition) => {
      const selected = profile.admin_grants.includes(definition.id);
      return {
        id: `admin-${definition.id}`,
        label: definition.label,
        tuple: materializedDiagnosticTuple(definition.tuple(subject)),
        expected_member: false,
        expected_admin: selected,
      };
    }),
  ];
}

function materializedDiagnosticTuple(tuple: OpenFgaTupleKey): OpenFgaTupleKey {
  const relationMap: Record<string, string> = {
    admin: "can_manage",
    manager: "can_manage",
    member: "can_use",
    owner: "can_read",
    reader: "can_read",
  };
  return { ...tuple, relation: relationMap[tuple.relation] ?? tuple.relation };
}

export function baselineGrantCatalog(): {
  member: BaselineFgaGrantDefinition[];
  admin: BaselineFgaGrantDefinition[];
} {
  return {
    member: memberBaselineGrantDefinitions(),
    admin: adminBaselineGrantDefinitions(),
  };
}

export function baselineTupleKey(tuple: OpenFgaTupleKey): string {
  return `${tuple.user}\u0000${tuple.relation}\u0000${tuple.object}`;
}
