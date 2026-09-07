export type PublicationResourceKind =
  | "rag_datasource"
  | "rag_collection"
  | "slack_channel"
  | "webex_space";

export type PublicationRequestStatus =
  | "pending"
  | "applying"
  | "approved"
  | "rejected"
  | "cancelled"
  | "superseded";

export type PublicationAuditAction =
  | "requested"
  | "auto_approved"
  | "approval_started"
  | "approved"
  | "rejected"
  | "cancelled"
  | "superseded"
  | "apply_failed";

export interface PublicationActor {
  subject: string;
  email?: string | null;
  name?: string | null;
}

export interface PublicationAuditEntry {
  action: PublicationAuditAction;
  at: string;
  actor: PublicationActor;
  note?: string;
  from_status?: PublicationRequestStatus;
  to_status?: PublicationRequestStatus;
}

export interface PublicationRiskFacts {
  organization_wide: boolean;
  target_team_slugs: string[];
  added_team_slugs?: string[];
  removed_team_slugs?: string[];
  added_user_subjects?: string[];
  removed_source_ids?: string[];
  source_type?: string;
  source_domain?: string;
  estimated_items?: number;
  member_count?: number;
  material_change?: boolean;
  reasons: string[];
  [key: string]: unknown;
}

export interface PublicationResourceRef {
  kind: PublicationResourceKind;
  id: string;
  label: string;
}

export interface PublicationRequestDocument {
  _id: string;
  adapter_version: 1;
  resource: PublicationResourceRef;
  /** Request-scoped OpenFGA policy object, bound to kind + resource hash. */
  authorization_policy_id: string;
  resource_revision: string;
  requested_state: Record<string, unknown>;
  effective_state: Record<string, unknown>;
  risk_facts: PublicationRiskFacts;
  requester: PublicationActor;
  requester_team_slugs: string[];
  approver_team_slugs: string[];
  /** Direct people delegated to review this request. */
  approver_user_subjects?: string[];
  status: PublicationRequestStatus;
  history: PublicationAuditEntry[];
  decision_note?: string;
  last_error?: string;
  created_at: string;
  updated_at: string;
  decided_at?: string;
  decided_by?: PublicationActor;
  apply_started_at?: string;
}

/** Requester-safe projection used by datasource management surfaces. */
export interface PendingPublicationRequestView {
  id: string;
  status: "pending" | "applying";
  requested_state: Record<string, unknown>;
  effective_state: Record<string, unknown>;
  risk_facts: PublicationRiskFacts;
  requester: PublicationActor;
  created_at: string;
}

/** Requester-safe state shown beside a discovered Slack channel or Webex space. */
export interface PendingConnectorPublicationRequestView {
  id: string;
  status: "pending" | "applying";
  requester: PublicationActor;
  requester_is_viewer: boolean;
  team_slug: string;
  agent_id: string;
  bot_id?: string;
  approver_team_slugs: string[];
  approver_user_subjects: string[];
}

export interface PublicationThresholds {
  slack_channel_members_without_approval: number;
  webex_space_members_without_approval: number;
}

export interface PublicationApprovalSettings {
  require_rag_publication_approval: boolean;
  require_slack_onboarding_approval: boolean;
  require_webex_onboarding_approval: boolean;
  allow_organization_wide_self_approval: boolean;
  trusted_publishers_bypass: boolean;
  trusted_publisher_subjects: string[];
  trusted_publisher_team_slugs: string[];
  organization_wide_team_slugs: string[];
  rag_reviewer_team_slugs: string[];
  rag_reviewer_user_subjects: string[];
  slack_reviewer_team_slugs: string[];
  slack_reviewer_user_subjects: string[];
  webex_reviewer_team_slugs: string[];
  webex_reviewer_user_subjects: string[];
  rag_reviewer_team_delegations: Record<string, string[]>;
  rag_reviewer_user_delegations: Record<string, string[]>;
  thresholds: PublicationThresholds;
}

export interface PublicationPolicyPlan {
  requires_approval: boolean;
  reason: string;
  effective_state: Record<string, unknown>;
  risk_facts: PublicationRiskFacts;
  approver_team_slugs: string[];
  approver_user_subjects: string[];
  requester_team_slugs: string[];
}

export interface PublicationRequestSummary {
  pending_count: number;
  requester_pending_count: number;
  can_approve: boolean;
  can_manage_settings: boolean;
}

export interface PublicationRequestPage {
  requests: PublicationRequestDocument[];
  pagination: {
    page: number;
    page_size: number;
    total: number;
    total_pages: number;
  };
}
