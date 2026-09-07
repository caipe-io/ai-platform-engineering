/**
 * Per-type FGA enforcement manifest (spec 2026-06-04-fga-coverage-guarantee,
 * Layer 2).
 *
 * This is the single artifact an auditor reads to answer "is resource type X
 * gated, and where?". Every type in `UNIVERSAL_REBAC_RESOURCE_TYPES` MUST have an
 * entry here; the `fga-enforcement-manifest.test.ts` guard fails CI on any missing
 * or `not_gated`-without-allowlist type, and asserts that `rebac_enforced` surfaces
 * point at files that actually exist.
 *
 * Status meanings:
 *   - rebac_enforced : an OpenFGA check gates runtime access on this type.
 *   - role_gated     : gated by Keycloak / coarse roles (FGA tuples may be written
 *                      but are not the runtime gate yet).
 *   - rebac_shadowed : FGA tuples are written/evaluated in shadow, not yet the gate.
 *   - not_gated      : intentionally ungated — only allowed via NOT_GATED_ALLOWLIST.
 *
 * `surfaces` are repo-relative paths to the authoritative enforcement / reconcile
 * code for the type. For `rebac_enforced` types the guard requires each path to
 * exist on disk (so a refactor that moves the gate updates the manifest).
 *
 * assisted-by Cursor claude-opus-4.8
 */

import type { UniversalRebacResourceType } from "@/types/rbac-universal";
import type { RebacEnforcementStatus } from "./resource-catalog";

export interface FgaEnforcementManifestEntry {
  status: RebacEnforcementStatus;
  surfaces: string[];
  notes: string;
}

/**
 * Types that are intentionally NOT gated by FGA. Each needs a documented reason;
 * the Layer-2 guard rejects `not_gated` for any type outside this allowlist.
 */
export const NOT_GATED_ALLOWLIST: Partial<
  Record<UniversalRebacResourceType, string>
> = {
  secret_ref:
    "Secret metadata/use is gated by the credential service + Keycloak; FGA tuples " +
    "exist for sharing but the runtime gate is the credential exchange route. " +
    "Tracked for ReBAC enforcement under the credential-exchange spec.",
};

export const FGA_ENFORCEMENT_MANIFEST: Record<
  UniversalRebacResourceType,
  FgaEnforcementManifestEntry
> = {
  organization: {
    status: "rebac_enforced",
    surfaces: [
      "ui/src/app/api/rbac/kb-tab-gates/route.ts",
      "ui/src/app/api/rag/[...path]/route.ts",
    ],
    notes:
      "Org-level capabilities (can_search, can_ingest, can_manage) checked on the data path and tab gates.",
  },
  user: {
    status: "role_gated",
    surfaces: ["ui/src/app/api/auth/role/route.ts"],
    notes:
      "User identity/role resolution; admin user management is Keycloak-gated.",
  },
  user_profile: {
    status: "rebac_enforced",
    surfaces: ["ui/src/lib/rbac/login-openfga-bootstrap.ts"],
    notes:
      "Self-read profile object keyed by Keycloak subject; bootstrapped + checked via OpenFGA.",
  },
  external_group: {
    status: "rebac_shadowed",
    surfaces: ["ui/src/lib/rbac/identity-group-sync-reconciler.ts"],
    notes:
      "Imported enterprise group; membership reconciled to tuples, not a direct gate.",
  },
  team: {
    status: "rebac_enforced",
    surfaces: ["ui/src/app/api/admin/teams/[id]/kb-assignments/route.ts"],
    notes:
      "Team membership drives can_use/can_manage on owned resources via team#member usersets.",
  },
  slack_workspace: {
    status: "role_gated",
    surfaces: ["ui/src/app/api/admin/slack/channels/route.ts"],
    notes:
      "Slack workspace config; channel grants reconciled to FGA, admin gate is Keycloak.",
  },
  slack_channel: {
    status: "rebac_enforced",
    surfaces: [
      "ui/src/app/api/integrations/slack/channels/[workspaceId]/[channelId]/access-check/route.ts",
    ],
    notes: "Channel-scoped resource access checked via OpenFGA usersets.",
  },
  webex_workspace: {
    status: "role_gated",
    surfaces: ["ui/src/app/api/admin/webex/spaces/route.ts"],
    notes:
      "Webex workspace config; space grants reconciled to FGA, admin gate is Keycloak.",
  },
  webex_space: {
    status: "rebac_enforced",
    surfaces: [
      "ui/src/app/api/integrations/webex/spaces/[workspaceId]/[spaceId]/access-check/route.ts",
    ],
    notes: "Space-scoped resource access checked via OpenFGA usersets.",
  },
  agent: {
    status: "rebac_enforced",
    surfaces: [
      "ui/src/lib/rbac/openfga-agent-authz.ts",
      "ui/src/app/api/dynamic-agents/route.ts",
    ],
    notes:
      "agent#can_use gates execution; reconcileAgentRelationships writes ownership/share tuples.",
  },
  llm_model: {
    status: "rebac_enforced",
    surfaces: ["ui/src/app/api/llm-models/route.ts"],
    notes: "llm_model read/manage filtered + reconciled via OpenFGA.",
  },
  mcp_gateway: {
    status: "rebac_enforced",
    surfaces: ["deploy/openfga/bridge/main.py"],
    notes:
      "Coarse AGW gate: user can_call mcp_gateway:list, enforced by the ext_authz bridge.",
  },
  mcp_server: {
    status: "role_gated",
    surfaces: ["ui/src/app/api/mcp-servers/route.ts"],
    notes:
      "Server registration Keycloak-gated; reconcileMcpServerRelationships writes tuples.",
  },
  tool: {
    status: "rebac_enforced",
    surfaces: ["deploy/openfga/bridge/main.py"],
    notes:
      "Per-tool can_call enforced by the AGW ext_authz bridge on tools/call.",
  },
  rag_collection: {
    status: "rebac_enforced",
    surfaces: [
      "ui/src/app/api/rag/collections/route.ts",
      "ui/src/app/api/rag/collections/[id]/route.ts",
    ],
    notes:
      "Collection read/publish/manage is checked in the BFF; member sources inherit collection read access through knowledge_base#parent_collection.",
  },
  knowledge_base: {
    status: "rebac_enforced",
    surfaces: [
      "ui/src/app/api/rag/kbs/[id]/sharing/route.ts",
      "ui/src/app/api/rag/[...path]/route.ts",
    ],
    notes:
      "KB read/ingest/manage checked + reconciled; data_source inherits via parent_kb.",
  },
  data_source: {
    status: "rebac_enforced",
    surfaces: ["ui/src/app/api/rag/[...path]/route.ts"],
    notes:
      "Datasource read filtered by can_read; create writes ownership server-side + reconciled.",
  },
  mcp_tool: {
    status: "rebac_enforced",
    surfaces: ["ui/src/app/api/rag/[...path]/route.ts"],
    notes:
      "mcp_tool#can_call gates custom-tool invocation; layered under org can_search.",
  },
  ingestion_source: {
    status: "rebac_enforced",
    surfaces: ["ui/src/lib/rbac/openfga-owned-resources-reconcile.ts"],
    notes:
      "Source CRUD gated by can_read/can_manage/can_delete; ownership reconciled via reconcileIngestionSourceRelationships.",
  },
  document: {
    status: "role_gated",
    surfaces: [
      "ai_platform_engineering/knowledge_bases/rag/server/src/server/restapi.py",
    ],
    notes:
      "Document access flows through KB/datasource gates; no standalone FGA gate yet.",
  },
  skill: {
    status: "role_gated",
    surfaces: ["ui/src/app/api/skills/configs/route.ts"],
    notes:
      "Skill catalog Keycloak-gated with team-grant patterns; not yet a direct FGA gate.",
  },
  task: {
    status: "role_gated",
    surfaces: ["ui/src/app/api/workflow-configs/route.ts"],
    notes:
      "Workflow configs map to the OpenFGA `task` namespace; Keycloak-gated today, FGA enforcement tracked separately.",
  },
  conversation: {
    status: "role_gated",
    surfaces: ["ui/src/app/api/chat/conversations/route.ts"],
    notes:
      "Conversation ownership/sharing gated in-app; FGA enforcement tracked separately.",
  },
  admin_surface: {
    status: "rebac_enforced",
    surfaces: ["ui/src/app/api/rbac/admin-tab-gates/route.ts"],
    notes:
      "Admin surfaces gated by team#admin / organization#admin usersets via OpenFGA.",
  },
  policy: {
    status: "rebac_shadowed",
    surfaces: ["ui/src/lib/rbac/policy-change-validator.ts"],
    notes:
      "ReBAC policy change-sets validated; enforcement is admin-role gated today.",
  },
  audit_log: {
    status: "role_gated",
    surfaces: ["ui/src/app/api/rbac/admin-tab-gates/route.ts"],
    notes: "Audit views gated by team#admin / auditor roles.",
  },
  secret_ref: {
    status: "not_gated",
    surfaces: ["ui/src/app/api/credentials/exchange/route.ts"],
    notes:
      "See NOT_GATED_ALLOWLIST — gated by the credential service, FGA enforcement pending.",
  },
  system_config: {
    status: "role_gated",
    surfaces: ["ui/src/app/api/admin/platform-config/route.ts"],
    notes: "System configuration gated by team#admin via Keycloak.",
  },
};
