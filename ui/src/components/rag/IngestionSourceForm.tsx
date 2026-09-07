"use client";

/**
 * Create/edit form for a RAG ingestion source. New sources can render inline
 * in the Ingest panel; existing-source management uses the dialog shell.
 * (spec 2026-07-21-rag-source-config-db).
 *
 * The `source_type` selector switches between the 5 discriminated variants'
 * identity fields, which — like `IMMUTABLE_FIELDS` on the API
 * (`/api/rag/sources/[sourceId]/route.ts`) — can never change after
 * creation, so they're disabled in edit mode. `visibility` is never
 * rendered here: it's server-controlled (defaults to "team" on create via
 * `POST /api/rag/sources`, and only flips via config seeding/adoption).
 */

import { Button } from "@/components/ui/button";
import {
Dialog,
DialogContent,
DialogDescription,
DialogFooter,
DialogHeader,
DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
AccessSubjectMultiPicker,
AccessSubjectPicker,
type AccessSubjectOption,
type AccessSubjectRef,
} from "@/components/ui/access-subject-picker";
import {
TeamPicker,
type TeamPickerOption,
} from "@/components/ui/team-picker";
import { RagApiError } from "@/lib/rag-api";
import { parseConfluencePageUrl } from "@/lib/confluence-url";
import {
DEFAULT_RAG_INGESTOR_LIMITS,
normalizeRagIngestorLimits,
type RagIngestorLimits,
} from "@/lib/rag-ingestor-limits";
import { cn } from "@/lib/utils";
import type {
IngestionSourceConfig,
IngestionSourceType,
WebCrawlMode,
} from "@/types/ingestion-source";
import type { PendingPublicationRequestView } from "@/types/publication-approval";
import { Eye, Loader2 } from "lucide-react";
import { useEffect,useState } from "react";
import { DatasourceAccessFields } from "./DatasourceAccessFields";
import { PendingPublicationRequestNotice } from "./PendingPublicationRequestNotice";
import {
  CollectionSearchAccessNotice,
  collectionDerivedSearchAccess,
} from "./CollectionSearchAccess";

const DEFAULT_CHUNK_SIZE = 10000;
const DEFAULT_CHUNK_OVERLAP = 2000;
const DEFAULT_RELOAD_INTERVAL = 86400;

const SOURCE_TYPE_OPTIONS: Array<{ value: IngestionSourceType; label: string }> = [
  { value: "slack_channel", label: "Slack Channel" },
  { value: "confluence_space", label: "Confluence" },
  { value: "jira_project", label: "Jira Project" },
  { value: "web_url", label: "Web URL" },
  { value: "webex_space", label: "Webex Space" },
];

interface TeamRow {
  _id?: string;
  slug?: string;
  name?: string;
}

export interface IngestionSourceFormValues {
  source_type: IngestionSourceType;
  name: string;
  description: string;
  // Type-specific identity fields — only the ones matching `source_type` are sent.
  channel_id: string;
  lookback_days: string;
  include_bots: boolean;
  confluence_url: string;
  space_key: string;
  start_page_url: string;
  get_child_pages: boolean;
  allowed_title_patterns: string;
  denied_title_patterns: string;
  project_key: string;
  source_slug: string;
  jql: string;
  include_comments: boolean;
  include_links: boolean;
  custom_fields: string;
  url: string;
  crawl_mode: WebCrawlMode;
  max_depth: number;
  max_pages: number;
  render_javascript: boolean;
  wait_for_selector: string;
  page_load_timeout: number;
  follow_external_links: boolean;
  allowed_url_patterns: string;
  denied_url_patterns: string;
  download_delay: number;
  concurrent_requests: number;
  respect_robots_txt: boolean;
  user_agent: string;
  allow_non_public_urls: boolean;
  space_id: string;
  // Shared mutable fields.
  default_chunk_size: number;
  default_chunk_overlap: number;
  reload_interval: number;
  owner_team_slug: string;
  owner_subject: string;
  search_team_slugs: string[];
  search_user_subjects: string[];
}

function emptyValues(sourceType: IngestionSourceType = "slack_channel"): IngestionSourceFormValues {
  return {
    source_type: sourceType,
    name: "",
    description: "",
    channel_id: "",
    lookback_days: "",
    include_bots: false,
    confluence_url: "",
    space_key: "",
    start_page_url: "",
    get_child_pages: false,
    allowed_title_patterns: "",
    denied_title_patterns: "",
    project_key: "",
    source_slug: "",
    jql: "",
    include_comments: true,
    include_links: true,
    custom_fields: "",
    url: "",
    crawl_mode: "sitemap",
    max_depth: 2,
    max_pages: 2000,
    render_javascript: false,
    wait_for_selector: "",
    page_load_timeout: 15,
    follow_external_links: true,
    allowed_url_patterns: "",
    denied_url_patterns: "",
    download_delay: 0.05,
    concurrent_requests: 30,
    respect_robots_txt: true,
    user_agent: "",
    allow_non_public_urls: false,
    space_id: "",
    default_chunk_size: DEFAULT_CHUNK_SIZE,
    default_chunk_overlap: DEFAULT_CHUNK_OVERLAP,
    reload_interval: DEFAULT_RELOAD_INTERVAL,
    owner_team_slug: "",
    owner_subject: "",
    search_team_slugs: [],
    search_user_subjects: [],
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function applyIngestorPolicy(
  current: IngestionSourceFormValues,
  limits: RagIngestorLimits,
  options: { clampNumerics: boolean },
): IngestionSourceFormValues {
  const featureCompliant = {
    ...current,
    include_bots:
      current.source_type === "slack_channel"
        ? current.include_bots && limits.slack.allow_bot_messages
        : current.source_type === "webex_space"
          ? current.include_bots && limits.webex.allow_bot_messages
          : current.include_bots,
    get_child_pages:
      current.get_child_pages && limits.confluence.allow_child_pages,
    include_comments: current.include_comments && limits.jira.allow_comments,
    include_links: current.include_links && limits.jira.allow_issue_links,
    render_javascript:
      current.render_javascript && limits.web.allow_javascript,
    follow_external_links:
      current.follow_external_links && limits.web.allow_external_links,
    respect_robots_txt: limits.web.allow_ignore_robots_txt
      ? current.respect_robots_txt
      : true,
    user_agent: limits.web.allow_custom_user_agent ? current.user_agent : "",
    allow_non_public_urls:
      current.allow_non_public_urls && limits.web.allow_non_public_urls,
  };

  // Existing numeric settings are not silently rewritten when an
  // administrator tightens a limit. Their current values remain visible and
  // the API blocks a non-compliant reload/edit until an owner deliberately
  // adjusts them. Disabled feature toggles are switched off because the user
  // cannot submit those features under the current policy.
  if (!options.clampNumerics) return featureCompliant;

  const defaultChunkSize = clamp(
    current.default_chunk_size,
    100,
    limits.shared.max_chunk_size,
  );
  const defaultChunkOverlap = Math.min(
    clamp(
      current.default_chunk_overlap,
      0,
      limits.shared.max_chunk_overlap,
    ),
    defaultChunkSize - 1,
  );
  const parsedLookback = current.lookback_days.trim()
    ? Number(current.lookback_days)
    : 30;
  const effectiveLookback = Number.isFinite(parsedLookback) ? parsedLookback : 30;
  const boundedLookback = clamp(
    effectiveLookback,
    limits.slack.allow_full_history ? 0 : 1,
    limits.slack.max_lookback_days,
  );

  return {
    ...featureCompliant,
    // Keep the normal optional/30-day presentation unless the administrator
    // has tightened it below that connector default.
    lookback_days:
      !current.lookback_days.trim() && boundedLookback === 30
        ? ""
        : String(boundedLookback),
    default_chunk_size: defaultChunkSize,
    default_chunk_overlap: defaultChunkOverlap,
    reload_interval: clamp(
      current.reload_interval,
      limits.shared.min_reload_interval_seconds,
      limits.shared.max_reload_interval_seconds,
    ),
    max_depth: clamp(current.max_depth, 1, limits.web.max_depth),
    max_pages: clamp(current.max_pages, 1, limits.web.max_pages),
    page_load_timeout: clamp(
      current.page_load_timeout,
      5,
      limits.web.max_page_load_timeout_seconds,
    ),
    download_delay: clamp(
      current.download_delay,
      limits.web.min_download_delay_seconds,
      limits.web.max_download_delay_seconds,
    ),
    concurrent_requests: clamp(
      current.concurrent_requests,
      1,
      limits.web.max_concurrent_requests,
    ),
  };
}

function valuesFromSource(source: IngestionSourceConfig): IngestionSourceFormValues {
  const base = emptyValues();
  return {
    ...base,
    source_type: source.source_type,
    name: source.name,
    description: source.description ?? "",
    channel_id: "channel_id" in source ? source.channel_id : "",
    lookback_days:
      "lookback_days" in source && source.lookback_days !== undefined
        ? String(source.lookback_days)
        : "",
    include_bots: "include_bots" in source ? Boolean(source.include_bots) : false,
    confluence_url: "confluence_url" in source ? source.confluence_url : "",
    space_key: "space_key" in source ? source.space_key : "",
    start_page_url: "start_page_url" in source ? source.start_page_url ?? "" : "",
    get_child_pages:
      "get_child_pages" in source ? Boolean(source.get_child_pages) : false,
    allowed_title_patterns:
      "allowed_title_patterns" in source
        ? (source.allowed_title_patterns ?? []).join("\n")
        : "",
    denied_title_patterns:
      "denied_title_patterns" in source
        ? (source.denied_title_patterns ?? []).join("\n")
        : "",
    project_key: "project_key" in source ? source.project_key : "",
    source_slug: "source_slug" in source ? source.source_slug : "",
    jql: "jql" in source ? source.jql : "",
    include_comments:
      "include_comments" in source ? source.include_comments !== false : true,
    include_links: "include_links" in source ? source.include_links !== false : true,
    custom_fields:
      "custom_fields" in source
        ? Object.entries(source.custom_fields ?? {})
            .map(([name, fieldId]) => `${name}=${fieldId}`)
            .join("\n")
        : "",
    url: "url" in source ? source.url : "",
    crawl_mode:
      "settings" in source ? source.settings?.crawl_mode ?? "single" : "sitemap",
    max_depth: "settings" in source ? source.settings?.max_depth ?? 2 : 2,
    max_pages: "settings" in source ? source.settings?.max_pages ?? 2000 : 2000,
    render_javascript:
      "settings" in source ? source.settings?.render_javascript ?? false : false,
    wait_for_selector:
      "settings" in source ? source.settings?.wait_for_selector ?? "" : "",
    page_load_timeout:
      "settings" in source ? source.settings?.page_load_timeout ?? 15 : 15,
    follow_external_links:
      "settings" in source ? source.settings?.follow_external_links ?? false : true,
    allowed_url_patterns:
      "settings" in source
        ? (source.settings?.allowed_url_patterns ?? []).join("\n")
        : "",
    denied_url_patterns:
      "settings" in source
        ? (source.settings?.denied_url_patterns ?? []).join("\n")
        : "",
    download_delay:
      "settings" in source ? source.settings?.download_delay ?? 0.05 : 0.05,
    concurrent_requests:
      "settings" in source ? source.settings?.concurrent_requests ?? 30 : 30,
    respect_robots_txt:
      "settings" in source ? source.settings?.respect_robots_txt ?? true : true,
    user_agent: "settings" in source ? source.settings?.user_agent ?? "" : "",
    allow_non_public_urls:
      "settings" in source ? source.settings?.allow_non_public_urls ?? false : false,
    space_id: "space_id" in source ? source.space_id : "",
    default_chunk_size: source.default_chunk_size,
    default_chunk_overlap: source.default_chunk_overlap,
    reload_interval: source.reload_interval,
    owner_team_slug: source.owner_team_slug ?? "",
    owner_subject: source.owner_subject ?? "",
    search_team_slugs:
      source.search_with_teams ??
      (source.search_owner_team_slug ? [source.search_owner_team_slug] : []),
    search_user_subjects: source.search_with_users ?? [],
  };
}

function valuesFromSourceWithPendingSearch(
  source: IngestionSourceConfig,
  request?: PendingPublicationRequestView | null,
): IngestionSourceFormValues {
  const values = valuesFromSource(source);
  if (!request) return values;
  if (Array.isArray(request.requested_state.search_team_slugs)) {
    values.search_team_slugs = request.requested_state.search_team_slugs.filter(
      (value): value is string => typeof value === "string" && Boolean(value.trim()),
    );
  }
  if (Array.isArray(request.requested_state.search_user_subjects)) {
    values.search_user_subjects = request.requested_state.search_user_subjects.filter(
      (value): value is string => typeof value === "string" && Boolean(value.trim()),
    );
  }
  return values;
}

/**
 * Payload sent to POST/PATCH — only fields relevant to the action + type.
 * `owner_team_slug`/`confirm_not_member` are added separately by the caller
 * only when a transfer is actually pending, so a plain metadata edit never
 * trips the PATCH route's ownership-transfer gate.
 */
function buildPayload(values: IngestionSourceFormValues, isEdit: boolean): Record<string, unknown> {
  const shared = {
    name: values.name.trim(),
    description: values.description.trim(),
    default_chunk_size: values.default_chunk_size,
    default_chunk_overlap: values.default_chunk_overlap,
    reload_interval: values.reload_interval,
    // Source management has exactly one optional owner team. Search grants
    // are the independent multi-team policy; there is no management-sharing
    // field in the form or PATCH contract.
    search_team_slugs: values.search_team_slugs,
    search_user_subjects: values.search_user_subjects,
  };

  if (isEdit) {
    // IMMUTABLE_FIELDS (source_type + identity fields) must never be sent on
    // PATCH — the API 400s on any attempted change.
    switch (values.source_type) {
      case "slack_channel":
        return { ...shared, lookback_days: numberOrUndefined(values.lookback_days), include_bots: values.include_bots };
      case "jira_project":
        return {
          ...shared,
          jql: values.jql.trim(),
          include_comments: values.include_comments,
          include_links: values.include_links,
          custom_fields: parseCustomFields(values.custom_fields),
        };
      case "confluence_space":
        return {
          ...shared,
          get_child_pages: values.get_child_pages,
          allowed_title_patterns: lineList(values.allowed_title_patterns),
          denied_title_patterns: lineList(values.denied_title_patterns),
        };
      case "web_url":
        return { ...shared, settings: webSettingsPayload(values) };
      case "webex_space":
        return { ...shared, include_bots: values.include_bots };
      default:
        return shared;
    }
  }

  const create: Record<string, unknown> = {
    ...shared,
    source_type: values.source_type,
    owner_team_slug: values.owner_team_slug.trim() || null,
  };
  switch (values.source_type) {
    case "slack_channel":
      create.channel_id = values.channel_id.trim();
      create.lookback_days = numberOrUndefined(values.lookback_days);
      create.include_bots = values.include_bots;
      break;
    case "confluence_space":
      create.url = values.start_page_url.trim();
      create.confluence_url =
        parseConfluencePageUrl(values.start_page_url)?.baseUrl ??
        values.confluence_url.trim();
      create.space_key = values.space_key.trim();
      create.start_page_url = values.start_page_url.trim();
      create.get_child_pages = values.get_child_pages;
      create.allowed_title_patterns = lineList(values.allowed_title_patterns);
      create.denied_title_patterns = lineList(values.denied_title_patterns);
      break;
    case "jira_project":
      create.project_key = values.project_key.trim();
      create.source_slug = values.source_slug.trim();
      create.jql = values.jql.trim();
      create.include_comments = values.include_comments;
      create.include_links = values.include_links;
      create.custom_fields = parseCustomFields(values.custom_fields);
      break;
    case "web_url":
      create.url = values.url.trim();
      create.settings = webSettingsPayload(values);
      break;
    case "webex_space":
      create.space_id = values.space_id.trim();
      create.include_bots = values.include_bots;
      break;
  }
  return create;
}

function lineList(value: string): string[] {
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseCustomFields(value: string): Record<string, string> {
  return Object.fromEntries(
    lineList(value).map((line) => {
      const separator = line.indexOf("=");
      if (separator <= 0 || separator === line.length - 1) {
        throw new Error("Each Jira custom field must use the format name=field_id.");
      }
      return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
    }),
  );
}

function webSettingsPayload(values: IngestionSourceFormValues): Record<string, unknown> {
  return {
    crawl_mode: values.crawl_mode,
    max_depth: values.max_depth,
    max_pages: values.max_pages,
    render_javascript: values.render_javascript,
    wait_for_selector: values.wait_for_selector.trim() || null,
    page_load_timeout: values.page_load_timeout,
    follow_external_links: values.follow_external_links,
    allowed_url_patterns: lineList(values.allowed_url_patterns),
    denied_url_patterns: lineList(values.denied_url_patterns),
    download_delay: values.download_delay,
    concurrent_requests: values.concurrent_requests,
    respect_robots_txt: values.respect_robots_txt,
    user_agent: values.user_agent.trim() || null,
    allow_non_public_urls: values.allow_non_public_urls,
    chunk_size: values.default_chunk_size,
    chunk_overlap: values.default_chunk_overlap,
  };
}

function numberOrUndefined(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function identityFieldsValid(values: IngestionSourceFormValues): boolean {
  switch (values.source_type) {
    case "slack_channel":
      return values.channel_id.trim().length > 0;
    case "confluence_space":
      return Boolean(
        values.space_key.trim() &&
          parseConfluencePageUrl(values.start_page_url)?.spaceKey ===
            values.space_key.trim(),
      );
    case "jira_project":
      return values.project_key.trim().length > 0 && values.source_slug.trim().length > 0;
    case "web_url":
      return values.url.trim().length > 0;
    case "webex_space":
      return values.space_id.trim().length > 0;
    default:
      return false;
  }
}

interface IngestionPreviewItem {
  id: string;
  title: string;
  url?: string;
  detail?: string;
}

interface IngestionPreviewResult {
  items: IngestionPreviewItem[];
  total_discovered: number;
  total_is_exact?: boolean;
  truncated: boolean;
  warnings?: string[];
  summary?: Record<string, unknown>;
}

const PREVIEW_PATHS: Partial<Record<IngestionSourceType, string>> = {
  web_url: "/api/rag/v1/ingest/webloader/preview",
  confluence_space: "/api/rag/v1/ingest/confluence/preview",
  jira_project: "/api/rag/v1/ingest/jira/preview",
};

function buildPreviewPayload(
  values: IngestionSourceFormValues,
  isEdit: boolean,
  sourceId?: string,
): Record<string, unknown> {
  const common = {
    description: values.description.trim(),
    owner_team_slug: values.owner_team_slug.trim() || null,
    ownership_preprovisioned: isEdit,
    default_chunk_size: values.default_chunk_size,
    default_chunk_overlap: values.default_chunk_overlap,
    reload_interval: values.reload_interval,
  };
  switch (values.source_type) {
    case "web_url":
      return {
        url: values.url.trim(),
        description: common.description,
        owner_team_slug: common.owner_team_slug,
        ownership_preprovisioned: common.ownership_preprovisioned,
        reload_interval: common.reload_interval,
        settings: webSettingsPayload(values),
      };
    case "confluence_space":
      return {
        ...common,
        name: values.name.trim(),
        url: values.start_page_url.trim(),
        ...(isEdit && sourceId
          ? { preprovisioned_datasource_id: sourceId }
          : {}),
        get_child_pages: values.get_child_pages,
        allowed_title_patterns: lineList(values.allowed_title_patterns),
        denied_title_patterns: lineList(values.denied_title_patterns),
      };
    case "jira_project":
      return {
        ...common,
        project_key: values.project_key.trim(),
        source_slug: values.source_slug.trim(),
        name: values.name.trim() || values.source_slug.trim(),
        jql: values.jql.trim(),
        include_comments: values.include_comments,
        include_links: values.include_links,
        custom_fields: parseCustomFields(values.custom_fields),
      };
    default:
      throw new Error("Preview is not available for this source type.");
  }
}

export interface IngestionSourceFormProps {
  open: boolean;
  onClose: () => void;
  onSave: (payload: Record<string, unknown>) => Promise<void>;
  initial?: IngestionSourceConfig | null;
  pendingPublicationRequest?: PendingPublicationRequestView | null;
  onPublicationRequestWithdrawn?: () => void | Promise<void>;
  defaultSourceType?: IngestionSourceType;
  displayMode?: "dialog" | "inline";
}

export function IngestionSourceForm({
  open,
  onClose,
  onSave,
  initial,
  pendingPublicationRequest,
  onPublicationRequestWithdrawn,
  defaultSourceType,
  displayMode = "dialog",
}: IngestionSourceFormProps) {
  const isEdit = Boolean(initial);
  const [values, setValues] = useState<IngestionSourceFormValues>(
    initial
      ? valuesFromSourceWithPendingSearch(initial, pendingPublicationRequest)
      : emptyValues(defaultSourceType),
  );
  const [availableOwnerTeams, setAvailableOwnerTeams] = useState<TeamRow[]>([]);
  const [availableSearchTeams, setAvailableSearchTeams] = useState<TeamRow[]>([]);
  const [defaultSearchTeamSlug, setDefaultSearchTeamSlug] = useState("");
  const [ingestorLimits, setIngestorLimits] = useState<RagIngestorLimits>(() =>
    normalizeRagIngestorLimits(DEFAULT_RAG_INGESTOR_LIMITS),
  );
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [previewResult, setPreviewResult] = useState<IngestionPreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Ownership transfer (edit only): changing the owner picker marks a pending
  // transfer, sent as owner_team_slug/confirm_not_member alongside the rest
  // of the PATCH body. Mirrors KbSharingPanel's transfer flow.
  const [transferRequested, setTransferRequested] = useState(false);
  const [transferConfirmedNotMember, setTransferConfirmedNotMember] = useState(false);
  const [transferNeedsServerConfirm, setTransferNeedsServerConfirm] = useState(false);

  useEffect(() => {
    if (!open) return;
    setValues(initial
      ? valuesFromSourceWithPendingSearch(initial, pendingPublicationRequest)
      : emptyValues(defaultSourceType));
    setSaving(false);
    setPreviewing(false);
    setPreviewResult(null);
    setError(null);
    setTransferRequested(false);
    setTransferConfirmedNotMember(false);
    setTransferNeedsServerConfirm(false);

    Promise.all([
      fetch("/api/rbac/ingest-teams").then((res) => res.json()),
      fetch("/api/dynamic-agents/teams").then((res) => res.json()),
      fetch("/api/admin/platform-config").then((res) => res.json()),
    ])
      .then(([ingestTeamData, membershipTeamData, platformConfig]: [
        { teams?: TeamRow[] },
        { success?: boolean; data?: TeamRow[] },
        {
          success?: boolean;
          data?: {
            rag_default_search_team_slug?: string | null;
            rag_ingestor_limits?: unknown;
          };
        },
      ]) => {
        const membershipTeams =
          membershipTeamData?.success && Array.isArray(membershipTeamData.data)
            ? membershipTeamData.data
            : [];
        // Creating for a team is an organization-level author capability, so
        // the create picker must use the same eligible-team endpoint as File.
        // Existing-source transfers are not new-source creation and may target
        // any team the manager can act as (or any team for an org admin).
        setAvailableOwnerTeams(
          isEdit
            ? membershipTeams
            : Array.isArray(ingestTeamData?.teams)
              ? ingestTeamData.teams
              : [],
        );
        setAvailableSearchTeams(membershipTeams);
        const limits = normalizeRagIngestorLimits(
          platformConfig?.data?.rag_ingestor_limits,
        );
        setIngestorLimits(limits);
        setValues((current) =>
          applyIngestorPolicy(current, limits, { clampNumerics: !initial }),
        );
        if (!initial) {
          const defaultSearchTeam = platformConfig?.data?.rag_default_search_team_slug;
          const normalizedDefault =
            typeof defaultSearchTeam === "string" && limits.shared.max_search_teams > 0
              ? defaultSearchTeam.trim()
              : "";
          setDefaultSearchTeamSlug(normalizedDefault);
          setValues((current) => ({
            ...current,
            search_team_slugs: normalizedDefault ? [normalizedDefault] : [],
          }));
        }
      })
      .catch((error: unknown) => {
        console.error("[IngestionSourceForm] Failed to load access options:", error);
      });
  }, [open, initial, pendingPublicationRequest, defaultSourceType, isEdit]);

  const canSave =
    values.name.trim().length > 0 &&
    (isEdit || identityFieldsValid(values));

  const handleSave = async (opts?: { forceConfirmNotMember?: boolean }) => {
    setSaving(true);
    setError(null);
    setTransferNeedsServerConfirm(false);
    // `setState` is async, so a confirm-and-retry can't rely on the freshly-set
    // `transferConfirmedNotMember` — the caller passes the value through opts.
    const confirmNotMember = opts?.forceConfirmNotMember || transferConfirmedNotMember;
    try {
      const payload = {
        ...buildPayload(values, isEdit),
        ...(isEdit && transferRequested
          ? {
              owner_team_slug: values.owner_team_slug || null,
              owner_subject: values.owner_subject || null,
              confirm_not_member: confirmNotMember,
            }
          : {}),
      };
      await onSave(payload);
      setTransferRequested(false);
      setTransferConfirmedNotMember(false);
      if (!isEdit && displayMode === "inline") {
        const resetValues = applyIngestorPolicy(
          emptyValues(defaultSourceType),
          ingestorLimits,
          { clampNumerics: true },
        );
        resetValues.search_team_slugs = defaultSearchTeamSlug
          ? [defaultSearchTeamSlug]
          : [];
        setValues(resetValues);
      }
    } catch (err) {
      if (
        err instanceof RagApiError &&
        (err.code === "TRANSFER_NOT_MEMBER_UNCONFIRMED" || err.code === "TRANSFER_CONFIRMATION_REQUIRED")
      ) {
        setTransferNeedsServerConfirm(true);
        setError(
          err.serverMessage || 'Confirm the ownership transfer to continue.',
        );
        return;
      }
      const serverMessage = err instanceof RagApiError ? err.serverMessage : undefined;
      setError(
        serverMessage ||
          (err instanceof Error ? err.message : "Could not save the source. Please try again."),
      );
    } finally {
      setSaving(false);
    }
  };

  const handleConfirmTransfer = () => {
    setTransferConfirmedNotMember(true);
    void handleSave({ forceConfirmNotMember: true });
  };

  const handlePreview = async (): Promise<void> => {
    const path = PREVIEW_PATHS[values.source_type];
    if (!path) return;
    setPreviewing(true);
    setPreviewResult(null);
    setError(null);
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          buildPreviewPayload(values, isEdit, initial?.source_id),
        ),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          typeof result?.detail === "string"
            ? result.detail
            : typeof result?.error === "string"
              ? result.error
              : `Preview failed (${response.status})`,
        );
      }
      if (!Array.isArray(result?.items)) {
        throw new Error("The ingestor returned an invalid preview.");
      }
      setPreviewResult({
        items: result.items,
        total_discovered:
          typeof result.total_discovered === "number"
            ? result.total_discovered
            : result.items.length,
        total_is_exact: result.total_is_exact === true,
        truncated: result.truncated === true,
        warnings: Array.isArray(result.warnings) ? result.warnings : [],
        summary:
          result.summary && typeof result.summary === "object" ? result.summary : undefined,
      });
    } catch (previewError) {
      setError(
        previewError instanceof Error
          ? previewError.message
          : "Could not preview this ingestion.",
      );
    } finally {
      setPreviewing(false);
    }
  };

  const ownerTeamOptions: TeamPickerOption[] = availableOwnerTeams
    .filter((team): team is TeamRow & { slug: string } => Boolean(team.slug))
    .map((team) => ({
      slug: team.slug,
      name: team.name ?? team.slug,
      _id: team._id,
    }));

  const searchTeamOptions: TeamPickerOption[] = availableSearchTeams
    .filter((team): team is TeamRow & { slug: string } => Boolean(team.slug))
    .map((team) => ({
      slug: team.slug,
      name: team.name ?? team.slug,
      _id: team._id,
    }));

  const knownAccessUsers: AccessSubjectOption[] = [
    ...(initial?.owner_subject
      ? [{
          kind: "user" as const,
          id: initial.owner_subject,
          name: initial.owner_display_name || initial.owner_email || "Unknown user",
          email: initial.owner_email,
        }]
      : []),
    ...((initial?.search_with_users ?? []).map((subject, index) => ({
      kind: "user" as const,
      id: subject,
      name: initial?.search_user_display_names?.[index] || "Unknown user",
    }))),
  ];

  const ownerAccessRef: AccessSubjectRef | null = values.owner_team_slug
    ? { kind: "team", id: values.owner_team_slug }
    : values.owner_subject
      ? { kind: "user", id: values.owner_subject }
      : null;
  const searchAccessRefs: AccessSubjectRef[] = [
    ...values.search_team_slugs.map((id) => ({ kind: "team" as const, id })),
    ...values.search_user_subjects.map((id) => ({ kind: "user" as const, id })),
  ];
  const collectionSearchAccess = collectionDerivedSearchAccess(
    initial?.rag_collections ?? [],
  );
  const implicitSearchAccess = [
    ...(ownerAccessRef?.kind === "user" ? [ownerAccessRef] : []),
    ...collectionSearchAccess.selections,
  ].filter(
    (ref, index, refs) =>
      refs.findIndex(
        (candidate) => candidate.kind === ref.kind && candidate.id === ref.id,
      ) === index,
  );

  const handleOwnerTeamChange = (slug: string) => {
    setValues((current) => ({ ...current, owner_team_slug: slug, owner_subject: "" }));
    if (isEdit) {
      const changed = slug !== (initial?.owner_team_slug ?? "") || Boolean(initial?.owner_subject);
      setTransferRequested(changed);
      setTransferConfirmedNotMember(false);
      setTransferNeedsServerConfirm(false);
    }
  };

  const handleOwnerAccessChange = (next: AccessSubjectRef) => {
    setValues((current) => ({
      ...current,
      owner_team_slug: next.kind === "team" ? next.id : "",
      owner_subject: next.kind === "user" ? next.id : "",
    }));
    const changed = next.kind === "team"
      ? next.id !== (initial?.owner_team_slug ?? "") || Boolean(initial?.owner_subject)
      : next.id !== (initial?.owner_subject ?? "") || Boolean(initial?.owner_team_slug);
    setTransferRequested(changed);
    setTransferConfirmedNotMember(false);
    setTransferNeedsServerConfirm(false);
    setError(null);
  };

  const handleSearchAccessChange = (next: AccessSubjectRef[]) => {
    setValues((current) => ({
      ...current,
      search_team_slugs: next.filter((ref) => ref.kind === "team").map((ref) => ref.id),
      search_user_subjects: next.filter((ref) => ref.kind === "user").map((ref) => ref.id),
    }));
  };

  const formFields = (
    <>
        <div className="space-y-4 py-2">
          {displayMode === "dialog" && (
          <div className="space-y-1.5">
            <Label htmlFor="source-type">Source Type</Label>
            <Select
              id="source-type"
              value={values.source_type}
              onChange={(e) =>
                setValues((v) => ({ ...v, source_type: e.target.value as IngestionSourceType }))
              }
              disabled={isEdit}
              className="w-full h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            >
              {SOURCE_TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="source-name">
              Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="source-name"
              value={values.name}
              onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))}
              placeholder="e.g. Platform Team Slack Channel"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="source-description">Description</Label>
            <Input
              id="source-description"
              value={values.description}
              onChange={(e) => setValues((v) => ({ ...v, description: e.target.value }))}
              placeholder="Optional description"
            />
          </div>

          {/* Type-specific identity fields — immutable once created. */}
          {values.source_type === "slack_channel" && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="channel-id">
                  Channel ID {!isEdit && <span className="text-destructive">*</span>}
                </Label>
                <Input
                  id="channel-id"
                  value={values.channel_id}
                  onChange={(e) => setValues((v) => ({ ...v, channel_id: e.target.value }))}
                  disabled={isEdit}
                  placeholder="e.g. C0123456789"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="lookback-days">Lookback Days</Label>
                <Input
                  id="lookback-days"
                  type="number"
                  min={ingestorLimits.slack.allow_full_history ? 0 : 1}
                  max={ingestorLimits.slack.max_lookback_days}
                  value={values.lookback_days}
                  onChange={(e) => setValues((v) => ({ ...v, lookback_days: e.target.value }))}
                  placeholder={`Optional (maximum ${ingestorLimits.slack.max_lookback_days})`}
                />
              </div>
              <BoolToggle
                label="Include bot messages"
                checked={values.include_bots}
                disabled={saving || !ingestorLimits.slack.allow_bot_messages}
                onChange={(checked) => setValues((v) => ({ ...v, include_bots: checked }))}
              />
            </>
          )}

          {values.source_type === "confluence_space" && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="start-page-url">
                  URL {!isEdit && <span className="text-destructive">*</span>}
                </Label>
                <Input
                  id="start-page-url"
                  value={values.start_page_url}
                  onChange={(e) => {
                    const startPageUrl = e.target.value;
                    const parsed = parseConfluencePageUrl(startPageUrl);
                    setValues((current) => ({
                      ...current,
                      start_page_url: startPageUrl,
                      confluence_url: parsed?.baseUrl ?? "",
                    }));
                  }}
                  disabled={isEdit}
                  placeholder="https://example.atlassian.net/wiki/spaces/ENG/pages/123/Overview"
                />
                <p className="text-xs text-muted-foreground">
                  Paste the page URL. Its page ID is detected automatically.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="space-key">
                  Space Key {!isEdit && <span className="text-destructive">*</span>}
                </Label>
                <Input
                  id="space-key"
                  value={values.space_key}
                  onChange={(e) => setValues((v) => ({ ...v, space_key: e.target.value }))}
                  disabled={isEdit}
                  placeholder="e.g. ENG"
                />
              </div>
              <BoolToggle
                label="Include child pages"
                checked={values.get_child_pages}
                disabled={saving || !ingestorLimits.confluence.allow_child_pages}
                onChange={(checked) =>
                  setValues((v) => ({ ...v, get_child_pages: checked }))
                }
              />
              <details className="rounded-lg border border-border/50 p-3">
                <summary className="cursor-pointer text-sm font-medium">
                  Title filters
                </summary>
                <div className="mt-3 grid gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="allowed-title-patterns">
                      Allowed title patterns
                    </Label>
                    <Textarea
                      id="allowed-title-patterns"
                      value={values.allowed_title_patterns}
                      onChange={(e) =>
                        setValues((v) => ({
                          ...v,
                          allowed_title_patterns: e.target.value,
                        }))
                      }
                      placeholder="One regular expression per line"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="denied-title-patterns">
                      Denied title patterns
                    </Label>
                    <Textarea
                      id="denied-title-patterns"
                      value={values.denied_title_patterns}
                      onChange={(e) =>
                        setValues((v) => ({
                          ...v,
                          denied_title_patterns: e.target.value,
                        }))
                      }
                      placeholder="One regular expression per line"
                    />
                  </div>
                </div>
              </details>
            </>
          )}

          {values.source_type === "jira_project" && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="project-key">
                  Project Key {!isEdit && <span className="text-destructive">*</span>}
                </Label>
                <Input
                  id="project-key"
                  value={values.project_key}
                  onChange={(e) => setValues((v) => ({ ...v, project_key: e.target.value }))}
                  disabled={isEdit}
                  placeholder="e.g. ENG"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="source-slug">
                  Source Slug {!isEdit && <span className="text-destructive">*</span>}
                </Label>
                <Input
                  id="source-slug"
                  value={values.source_slug}
                  onChange={(e) => setValues((v) => ({ ...v, source_slug: e.target.value }))}
                  disabled={isEdit}
                  placeholder="Immutable identifier — does not change if the name changes"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="jql">JQL</Label>
                <Input
                  id="jql"
                  maxLength={ingestorLimits.jira.max_jql_length}
                  value={values.jql}
                  onChange={(e) => setValues((v) => ({ ...v, jql: e.target.value }))}
                  placeholder="e.g. project = ENG AND status != Done"
                />
              </div>
              <BoolToggle
                label="Include comments"
                checked={values.include_comments}
                disabled={saving || !ingestorLimits.jira.allow_comments}
                onChange={(checked) => setValues((v) => ({ ...v, include_comments: checked }))}
              />
              <BoolToggle
                label="Include linked issues"
                checked={values.include_links}
                disabled={saving || !ingestorLimits.jira.allow_issue_links}
                onChange={(checked) => setValues((v) => ({ ...v, include_links: checked }))}
              />
              <div className="space-y-1.5">
                <Label htmlFor="jira-custom-fields">Custom fields</Label>
                <Textarea
                  id="jira-custom-fields"
                  value={values.custom_fields}
                  onChange={(e) =>
                    setValues((v) => ({ ...v, custom_fields: e.target.value }))
                  }
                  placeholder={"slo=customfield_123\nservice=customfield_456"}
                />
                <p className="text-xs text-muted-foreground">
                  One friendly-name=field-id mapping per line.
                </p>
              </div>
            </>
          )}

          {values.source_type === "web_url" && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="web-url">
                  URL {!isEdit && <span className="text-destructive">*</span>}
                </Label>
                <Input
                  id="web-url"
                  value={values.url}
                  onChange={(e) => setValues((v) => ({ ...v, url: e.target.value }))}
                  disabled={isEdit}
                  placeholder="https://example.com/docs"
                />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="crawl-mode">Crawl mode</Label>
                  <Select
                    id="crawl-mode"
                    value={values.crawl_mode}
                    onChange={(e) =>
                      setValues((v) => ({
                        ...v,
                        crawl_mode: e.target.value as WebCrawlMode,
                      }))
                    }
                    className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                  >
                    <option value="single">Single page</option>
                    <option value="sitemap">Sitemap</option>
                    <option value="recursive">Recursive</option>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="max-pages">Maximum pages</Label>
                  <Input
                    id="max-pages"
                    type="number"
                    min={1}
                    max={ingestorLimits.web.max_pages}
                    value={values.max_pages}
                    onChange={(e) =>
                      setValues((v) => ({ ...v, max_pages: Number(e.target.value) }))
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="max-depth">Maximum depth</Label>
                  <Input
                    id="max-depth"
                    type="number"
                    min={1}
                    max={ingestorLimits.web.max_depth}
                    value={values.max_depth}
                    disabled={values.crawl_mode !== "recursive"}
                    onChange={(e) =>
                      setValues((v) => ({ ...v, max_depth: Number(e.target.value) }))
                    }
                  />
                </div>
              </div>
              <details className="rounded-lg border border-border/50 p-3">
                <summary className="cursor-pointer text-sm font-medium">
                  Advanced web crawl settings
                </summary>
                <div className="mt-3 space-y-3">
                  <div className="grid grid-cols-3 gap-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="page-load-timeout">Page timeout (s)</Label>
                      <Input
                        id="page-load-timeout"
                        type="number"
                        min={5}
                        max={ingestorLimits.web.max_page_load_timeout_seconds}
                        value={values.page_load_timeout}
                        onChange={(e) =>
                          setValues((v) => ({
                            ...v,
                            page_load_timeout: Number(e.target.value),
                          }))
                        }
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="download-delay">Download delay (s)</Label>
                      <Input
                        id="download-delay"
                        type="number"
                        min={ingestorLimits.web.min_download_delay_seconds}
                        max={ingestorLimits.web.max_download_delay_seconds}
                        step="0.01"
                        value={values.download_delay}
                        onChange={(e) =>
                          setValues((v) => ({
                            ...v,
                            download_delay: Number(e.target.value),
                          }))
                        }
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="concurrent-requests">Concurrency</Label>
                      <Input
                        id="concurrent-requests"
                        type="number"
                        min={1}
                        max={ingestorLimits.web.max_concurrent_requests}
                        value={values.concurrent_requests}
                        onChange={(e) =>
                          setValues((v) => ({
                            ...v,
                            concurrent_requests: Number(e.target.value),
                          }))
                        }
                      />
                    </div>
                  </div>
                  <BoolToggle
                    label="Render JavaScript"
                    checked={values.render_javascript}
                    disabled={saving || !ingestorLimits.web.allow_javascript}
                    onChange={(checked) =>
                      setValues((v) => ({ ...v, render_javascript: checked }))
                    }
                  />
                  {values.render_javascript && (
                    <div className="space-y-1.5">
                      <Label htmlFor="wait-for-selector">Wait for selector</Label>
                      <Input
                        id="wait-for-selector"
                        value={values.wait_for_selector}
                        onChange={(e) =>
                          setValues((v) => ({ ...v, wait_for_selector: e.target.value }))
                        }
                        placeholder="Optional CSS selector"
                      />
                    </div>
                  )}
                  <BoolToggle
                    label="Follow external links"
                    checked={values.follow_external_links}
                    disabled={saving || !ingestorLimits.web.allow_external_links}
                    onChange={(checked) =>
                      setValues((v) => ({ ...v, follow_external_links: checked }))
                    }
                  />
                  <BoolToggle
                    label="Respect robots.txt"
                    checked={values.respect_robots_txt}
                    disabled={saving || !ingestorLimits.web.allow_ignore_robots_txt}
                    onChange={(checked) =>
                      setValues((v) => ({ ...v, respect_robots_txt: checked }))
                    }
                  />
                  <BoolToggle
                    label="Allow internal or private URLs"
                    checked={values.allow_non_public_urls}
                    disabled={saving || !ingestorLimits.web.allow_non_public_urls}
                    onChange={(checked) =>
                      setValues((v) => ({ ...v, allow_non_public_urls: checked }))
                    }
                  />
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="allowed-url-patterns">Allowed URL patterns</Label>
                      <Textarea
                        id="allowed-url-patterns"
                        value={values.allowed_url_patterns}
                        onChange={(e) =>
                          setValues((v) => ({
                            ...v,
                            allowed_url_patterns: e.target.value,
                          }))
                        }
                        placeholder="One regular expression per line"
                      />
                      <p className="text-xs text-muted-foreground">
                        Regular expressions, not wildcard patterns. Example:{" "}
                        <code>/docs/0\.4\.18/.*</code>
                      </p>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="denied-url-patterns">Denied URL patterns</Label>
                      <Textarea
                        id="denied-url-patterns"
                        value={values.denied_url_patterns}
                        onChange={(e) =>
                          setValues((v) => ({
                            ...v,
                            denied_url_patterns: e.target.value,
                          }))
                        }
                        placeholder="One regular expression per line"
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="user-agent">User agent</Label>
                    <Input
                      id="user-agent"
                      value={values.user_agent}
                      disabled={saving || !ingestorLimits.web.allow_custom_user_agent}
                      onChange={(e) =>
                        setValues((v) => ({ ...v, user_agent: e.target.value }))
                      }
                      placeholder="Optional custom user agent"
                    />
                  </div>
                </div>
              </details>
            </>
          )}

          {values.source_type === "webex_space" && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="space-id">
                  Space ID {!isEdit && <span className="text-destructive">*</span>}
                </Label>
                <Input
                  id="space-id"
                  value={values.space_id}
                  onChange={(e) => setValues((v) => ({ ...v, space_id: e.target.value }))}
                  disabled={isEdit}
                  placeholder="e.g. Y2lzY29zcGFyazovL3VzL1JPT00v..."
                />
              </div>
              <BoolToggle
                label="Include bot messages"
                checked={values.include_bots}
                disabled={saving || !ingestorLimits.webex.allow_bot_messages}
                onChange={(checked) => setValues((v) => ({ ...v, include_bots: checked }))}
              />
            </>
          )}

          {PREVIEW_PATHS[values.source_type] && (
            <div className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">Preview ingestion</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Runs these connector settings without saving a source or indexing data.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="gap-2"
                  disabled={
                    saving ||
                    previewing ||
                    !identityFieldsValid(values) ||
                    (values.source_type === "jira_project" && !values.jql.trim())
                  }
                  onClick={() => void handlePreview()}
                >
                  {previewing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                  {previewing ? "Running preview…" : "Preview ingestion"}
                </Button>
              </div>

              {previewResult && (
                <div className="space-y-2" aria-live="polite">
                  <p className="text-xs font-medium text-foreground">
                    {previewResult.truncated && !previewResult.total_is_exact ? "At least " : ""}
                    {previewResult.total_discovered} item
                    {previewResult.total_discovered === 1 ? "" : "s"} matched
                    {previewResult.truncated ? "; showing a bounded sample." : "."}
                  </p>
                  {previewResult.items.length === 0 ? (
                    <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                      No items matched these settings.
                    </p>
                  ) : (
                    <div className="max-h-80 divide-y divide-border/50 overflow-y-auto rounded-md border bg-background p-1">
                      {previewResult.items.map((item) => (
                        <div
                          key={item.id}
                          className="rounded px-2 py-1 text-xs hover:bg-muted/50"
                        >
                          {item.url ? (
                            <p className="truncate text-muted-foreground" title={item.url}>
                              {item.url}
                            </p>
                          ) : (
                            <>
                              <p className="font-medium text-foreground">{item.title}</p>
                              {item.detail && (
                                <p className="mt-0.5 text-muted-foreground">{item.detail}</p>
                              )}
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {(previewResult.warnings?.length ?? 0) > 0 && (
                    <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-amber-700 dark:text-amber-300">
                      {previewResult.warnings?.map((warning, index) => (
                        <p key={`${index}-${warning}`}>{warning}</p>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <details className="rounded-lg border border-border/60 p-4">
            <summary className="cursor-pointer text-sm font-medium">
              Advanced settings
            </summary>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="chunk-size">Chunk Size</Label>
                <Input
                  id="chunk-size"
                  type="number"
                  min={100}
                  max={ingestorLimits.shared.max_chunk_size}
                  value={values.default_chunk_size}
                  onChange={(e) =>
                    setValues((v) => ({ ...v, default_chunk_size: Number(e.target.value) }))
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="chunk-overlap">Chunk Overlap</Label>
                <Input
                  id="chunk-overlap"
                  type="number"
                  min={0}
                  max={ingestorLimits.shared.max_chunk_overlap}
                  value={values.default_chunk_overlap}
                  onChange={(e) =>
                    setValues((v) => ({ ...v, default_chunk_overlap: Number(e.target.value) }))
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="reload-interval">Reload Interval (s)</Label>
                <Input
                  id="reload-interval"
                  type="number"
                  min={ingestorLimits.shared.min_reload_interval_seconds}
                  max={ingestorLimits.shared.max_reload_interval_seconds}
                  value={values.reload_interval}
                  onChange={(e) =>
                    setValues((v) => ({ ...v, reload_interval: Number(e.target.value) }))
                  }
                />
              </div>
            </div>
          </details>

          <DatasourceAccessFields
            ownerControl={isEdit ? (
                <AccessSubjectPicker
                  id="source-owner"
                  value={ownerAccessRef}
                  onChange={handleOwnerAccessChange}
                  teams={ownerTeamOptions}
                  knownUsers={knownAccessUsers}
                  disabled={saving}
                  placeholder="Select a person or team"
                  searchPlaceholder="Search people or teams..."
                  ariaLabel="Owner"
                />
              ) : (
                <TeamPicker
                  id="source-owner"
                  value={values.owner_team_slug}
                  onChange={handleOwnerTeamChange}
                  options={ownerTeamOptions}
                  disabled={saving}
                  placeholder="You (personal)"
                  searchPlaceholder="Search teams..."
                  emptyLabel="No teams match"
                />
              )}
            ownerDescription={
              <>
                The Owner manages settings, reloads, transfers, and deletion. A
                personal Owner always has Search access; a team Owner must be
                added under Search.
              </>
            }
            ownerDetails={initial?.creator_subject ? (
                <p className="text-xs text-muted-foreground" data-testid="creator-subject">
                  Created by {initial.creator_display_name || initial.creator_email || "Unknown user"}
                  {initial.creator_email && initial.creator_email !== initial.creator_display_name
                    ? ` (${initial.creator_email})`
                    : ""}.
                </p>
              ) : undefined}
            searchControl={
              <AccessSubjectMultiPicker
                teams={searchTeamOptions}
                knownUsers={knownAccessUsers}
                implicitSelections={implicitSearchAccess}
                implicitSelectionLabel={(ref) =>
                  ownerAccessRef?.kind === "user" &&
                  ref.kind === ownerAccessRef.kind &&
                  ref.id === ownerAccessRef.id
                    ? "Included through ownership"
                    : collectionSearchAccess.labelFor(ref)
                }
                selected={searchAccessRefs.filter((ref) =>
                  ownerAccessRef?.kind !== "user" ||
                  ref.kind !== ownerAccessRef.kind ||
                  ref.id !== ownerAccessRef.id
                )}
                onChange={handleSearchAccessChange}
                disabled={saving}
                maxSelections={ingestorLimits.shared.max_search_teams + 50}
                maxSelectionsByKind={{
                  team: ingestorLimits.shared.max_search_teams,
                  user: 50,
                }}
                placeholder={ownerAccessRef?.kind === "team"
                  ? "No search access — add people or teams"
                  : isEdit
                    ? "Only the Owner can search — add others"
                    : "Only you can search — add others"}
                searchPlaceholder="Search people or teams..."
                emptyLabel="No people or teams match"
              />
            }
            searchDescription={
              <>
                Search access lets selected people and teams query this datasource
                through Search, APIs, and agents. It does not let them reload or
                manage it.
              </>
            }
            searchDetails={(
              <div className="space-y-2">
                {pendingPublicationRequest && (
                  <PendingPublicationRequestNotice
                    request={pendingPublicationRequest}
                    teams={searchTeamOptions}
                    knownUsers={knownAccessUsers}
                    onWithdrawn={onPublicationRequestWithdrawn}
                  />
                )}
                <CollectionSearchAccessNotice
                  collections={initial?.rag_collections ?? []}
                />
              </div>
            )}
          />
        </div>

        {error && (
          <div
            role="alert"
            className="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            <p>{error}</p>
            {transferNeedsServerConfirm && (
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={saving}
                onClick={handleConfirmTransfer}
              >
                Confirm Transfer
              </Button>
            )}
          </div>
        )}

        <DialogFooter>
          {displayMode === "dialog" && (
            <Button variant="outline" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
          )}
          <Button onClick={() => void handleSave()} disabled={saving || !canSave}>
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {isEdit ? "Save Changes" : displayMode === "inline" ? "Ingest Source" : "Create Source"}
          </Button>
        </DialogFooter>
    </>
  );

  if (displayMode === "inline") {
    if (!open) return null;
    const sourceTypeLabel = SOURCE_TYPE_OPTIONS.find(
      (option) => option.value === values.source_type,
    )?.label;

    return (
      <div
        className="space-y-4 rounded-lg border border-border/60 bg-muted/20 p-4"
        aria-label={`${sourceTypeLabel ?? "Ingestion source"} configuration`}
      >
        <div>
          <h4 className="text-sm font-semibold text-foreground">
            Configure {sourceTypeLabel ?? "source"}
          </h4>
          <p className="mt-1 text-xs text-muted-foreground">
            Saving this source starts ingestion immediately.
          </p>
        </div>
        {formFields}
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="h-[82vh] max-h-[720px] w-[95vw] grid-rows-[auto_minmax(0,1fr)] overflow-visible sm:max-w-[960px]">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Manage Datasource" : "New Ingestion Source"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update this source's connector settings and access."
              : "Configure the source and who can manage it."}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto pr-1">
          {formFields}
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface BoolToggleProps {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}

function BoolToggle({ label, checked, disabled, onChange }: BoolToggleProps) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border/50 p-3">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative w-9 shrink-0 rounded-full transition-colors",
          checked ? "bg-primary" : "bg-muted",
          disabled && "opacity-50 cursor-not-allowed",
        )}
        style={{ height: "20px" }}
      >
        <span
          className={cn(
            "absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow transition-all",
            checked ? "left-[calc(100%-16px)]" : "left-0.5",
          )}
        />
      </button>
      <Label className="cursor-pointer" onClick={() => !disabled && onChange(!checked)}>
        {label}
      </Label>
    </div>
  );
}

export default IngestionSourceForm;
