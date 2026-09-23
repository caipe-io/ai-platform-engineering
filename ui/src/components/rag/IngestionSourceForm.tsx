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
import { InlineTokenEditor } from "@/components/ui/inline-token-editor";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchablePicker } from "@/components/ui/searchable-picker";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
import { config } from "@/lib/config";
import { RagApiError } from "@/lib/rag-api";
import { parseConfluenceLocator } from "@/lib/confluence-url";
import {
DEFAULT_RAG_INGESTOR_LIMITS,
normalizeRagIngestorLimits,
type RagIngestorLimits,
} from "@/lib/rag-ingestor-limits";
import { shortMaskedPreview } from "@/lib/credentials/masking";
import { cn } from "@/lib/utils";
import type {
IngestionSourceConfig,
IngestionSourceType,
WebAuthHeader,
WebCrawlMode,
} from "@/types/ingestion-source";
import type { PendingPublicationRequestView } from "@/types/publication-approval";
import { Eye, Loader2, Lock, Plus, X } from "lucide-react";
import { useEffect,useState } from "react";
import { AdvancedSettings } from "./AdvancedSettings";
import { DatasourceAccessFields } from "./DatasourceAccessFields";
import { PendingPublicationRequestNotice } from "./PendingPublicationRequestNotice";
import { CollectionSearchAccessNotice } from "./CollectionSearchAccess";

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

/** Substituted with the resolved secret by the ingestor, never by the browser. */
const SECRET_PLACEHOLDER = "{{secret}}";
/** Scheme prefix only; the credential is appended when one is selected. */
const DEFAULT_AUTH_HEADER_TEMPLATE = "Bearer ";
const DEFAULT_AUTH_HEADER_NAME = "Authorization";
/** Mirrors MAX_AUTH_HEADERS in lib/ingestion-source-config.ts. */
const MAX_AUTH_HEADERS = 10;

const CREDENTIAL_FAILURE_HINT =
  "An invalid, expired, or insufficiently scoped credential usually returns a 404 " +
  "or a sign-in page instead of a 401, so check the credential and its access to " +
  "this site before changing crawl settings.";

interface TeamRow {
  _id?: string;
  slug?: string;
  name?: string;
}

interface SecretReferenceOption {
  id: string;
  name: string;
  type?: string;
  maskedPreview?: string;
}

interface AuthHeaderTestResult {
  ok: boolean;
  message: string;
  /**
   * Set only where the credential is genuinely the likely cause. A server that
   * reported a specific reason, such as missing configuration, is not second
   * guessed with credential advice that would send the reader somewhere else.
   */
  credentialHint?: boolean;
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
  auth_headers: WebAuthHeader[];
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
    auth_headers: [],
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
    auth_headers:
      "settings" in source
        ? (source.settings?.auth_headers ?? []).map((header) => ({ ...header }))
        : [],
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
 * Folder and whole-space sources always ingest every nested page, so the
 * toggle is hidden for them (see the "confluence_space" identity fields
 * below) and this always returns `true` regardless of its stored value.
 * Shared by the create/edit and preview payload builders so a source is
 * never previewed with a narrower scope than it will actually be saved with.
 */
function confluenceGetChildPages(values: IngestionSourceFormValues): boolean {
  const locator = parseConfluenceLocator(values.start_page_url);
  return locator?.kind === "page" ? values.get_child_pages : true;
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
          get_child_pages: confluenceGetChildPages(values),
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
    case "confluence_space": {
      const locator = parseConfluenceLocator(values.start_page_url);
      create.url = values.start_page_url.trim();
      create.confluence_url = locator?.baseUrl ?? values.confluence_url.trim();
      create.space_key = values.space_key.trim();
      create.start_page_url = values.start_page_url.trim();
      create.get_child_pages = confluenceGetChildPages(values);
      create.allowed_title_patterns = lineList(values.allowed_title_patterns);
      create.denied_title_patterns = lineList(values.denied_title_patterns);
      break;
    }
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

/**
 * Drops rows the ingestor could not resolve: a row needs a header name, a
 * secret, and a template with somewhere to substitute the resolved value.
 */
/**
 * Drops rows the API would reject, so an unfinished row never blocks a save.
 * A row is sendable once it has a name and a value, and — when it references a
 * credential — a placeholder marking where that credential belongs.
 */
function normalizedAuthHeaders(rows: WebAuthHeader[]): WebAuthHeader[] {
  return rows
    .map((row) => {
      const secretRef = row.secret_ref?.trim() ?? "";
      const valueTemplate = row.value_template.trim();
      return {
        header_name: row.header_name.trim(),
        value_template: valueTemplate,
        ...(secretRef ? { secret_ref: secretRef } : {}),
      };
    })
    .filter((row) => {
      if (!row.header_name || !row.value_template) return false;
      return row.secret_ref
        ? row.value_template.includes(SECRET_PLACEHOLDER)
        : !row.value_template.includes(SECRET_PLACEHOLDER);
    });
}

/**
 * Rows repeating an earlier row's header name, compared the way the API
 * compares them. A conflicting row is complete but unusable, so it is reported
 * on the row instead of being dropped from the payload.
 */
function duplicateAuthHeaderIndexes(rows: WebAuthHeader[]): Set<number> {
  const seen = new Set<string>();
  const duplicates = new Set<number>();
  rows.forEach((row, index) => {
    const key = row.header_name.trim().toLowerCase();
    if (!key) return;
    if (seen.has(key)) duplicates.add(index);
    else seen.add(key);
  });
  return duplicates;
}

/** Shell-style stand-in for a credential, derived from its display name. */
function secretTokenLabel(secret: SecretReferenceOption | undefined): string {
  if (!secret) return SECRET_PLACEHOLDER;
  const token = secret.name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return token ? `$${token}` : SECRET_PLACEHOLDER;
}

/**
 * The request the crawler will actually send, rendered as curl. Credential values
 * collapse to their trailing hint, so the preview stays safe to leave on screen.
 */
function authHeaderRequestPreview(input: {
  url: string;
  headers: WebAuthHeader[];
  secrets: SecretReferenceOption[];
  userAgent: string;
}): string[] {
  const sent: string[] = [];
  const userAgent = input.userAgent.trim();
  if (userAgent) sent.push(`User-Agent: ${userAgent}`);

  for (const header of input.headers) {
    if (!header.secret_ref) {
      sent.push(`${header.header_name}: ${header.value_template}`);
      continue;
    }
    const secret = input.secrets.find((option) => option.id === header.secret_ref);
    const hint = shortMaskedPreview(secret?.maskedPreview) ?? SECRET_PLACEHOLDER;
    const value = header.value_template.split(SECRET_PLACEHOLDER).join(hint);
    sent.push(`${header.header_name}: ${value}`);
  }

  if (sent.length === 0) return [];
  return [
    `curl '${input.url.trim() || "<source URL>"}' \\`,
    ...sent.map(
      (line, index) => `  -H '${line}'${index === sent.length - 1 ? "" : " \\"}`,
    ),
  ];
}

function webSettingsPayload(values: IngestionSourceFormValues): Record<string, unknown> {
  return {
    auth_headers: normalizedAuthHeaders(values.auth_headers),
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
      return Boolean(parseConfluenceLocator(values.start_page_url)?.spaceKey);
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

const WEB_PREVIEW_PATH = "/api/rag/v1/ingest/webloader/preview";

const PREVIEW_PATHS: Partial<Record<IngestionSourceType, string>> = {
  web_url: WEB_PREVIEW_PATH,
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
        get_child_pages: confluenceGetChildPages(values),
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
  readOnly?: boolean;
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
  readOnly = false,
}: IngestionSourceFormProps) {
  const isEdit = Boolean(initial);
  const isReadOnly = readOnly || initial?.config_driven === true;
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
  // Kept apart from the form-level error so the outcome reads beside the button
  // that produced it rather than at the foot of the dialog.
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [credentialSharingConfirmed, setCredentialSharingConfirmed] = useState(false);
  const [credentialSharingPrompt, setCredentialSharingPrompt] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const credentialsEnabled = config.credentialsEnabled;
  const [secretOptions, setSecretOptions] = useState<SecretReferenceOption[]>([]);
  const [secretsLoading, setSecretsLoading] = useState(false);
  const [testingAuthHeaders, setTestingAuthHeaders] = useState(false);
  const [authHeaderTestResult, setAuthHeaderTestResult] =
    useState<AuthHeaderTestResult | null>(null);
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
    setPreviewError(null);
    setError(null);
    setAuthHeaderTestResult(null);
    setCredentialSharingConfirmed(false);
    setCredentialSharingPrompt(false);
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

  useEffect(() => {
    if (!open || !credentialsEnabled) return;
    let cancelled = false;
    setSecretsLoading(true);
    fetch("/api/credentials/secrets")
      .then((response) => (response.ok ? response.json() : { data: [] }))
      .then((payload: { data?: unknown }) => {
        if (cancelled) return;
        setSecretOptions(
          Array.isArray(payload?.data) ? (payload.data as SecretReferenceOption[]) : [],
        );
      })
      .catch(() => {
        if (!cancelled) setSecretOptions([]);
      })
      .finally(() => {
        if (!cancelled) setSecretsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, credentialsEnabled]);

  const duplicateAuthHeaders = duplicateAuthHeaderIndexes(values.auth_headers);
  // Only blocks save where the rows are reachable and actually sent, so a
  // hidden section can never wedge an unrelated edit.
  const hasAuthHeaderConflict =
    credentialsEnabled &&
    values.source_type === "web_url" &&
    duplicateAuthHeaders.size > 0;

  const sentAuthHeaders = normalizedAuthHeaders(values.auth_headers);
  // Content gathered with a credential may not be public, so widening who can
  // reach it is a decision the owner should make deliberately.
  const usesCredential = sentAuthHeaders.some((header) => Boolean(header.secret_ref));
  const accessReachesOthers =
    Boolean(values.owner_team_slug.trim()) ||
    values.search_team_slugs.length > 0 ||
    values.search_user_subjects.length > 0;
  const needsCredentialSharingConfirm =
    usesCredential && accessReachesOthers && !credentialSharingConfirmed;
  const authHeaderPreviewLines = authHeaderRequestPreview({
    url: values.url,
    headers: sentAuthHeaders,
    secrets: secretOptions,
    userAgent: values.user_agent,
  });
  const unsentAuthHeaderCount = values.auth_headers.length - sentAuthHeaders.length;

  const canSave =
    !isReadOnly &&
    values.name.trim().length > 0 &&
    !hasAuthHeaderConflict &&
    (isEdit || identityFieldsValid(values));

  const handleSave = async (opts?: { forceConfirmNotMember?: boolean }) => {
    if (isReadOnly) return;
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
    setPreviewError(null);
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
    } catch (caught) {
      setPreviewError(
        caught instanceof Error ? caught.message : "Could not preview this ingestion.",
      );
    } finally {
      setPreviewing(false);
    }
  };

  const handleAddAuthHeader = () => {
    setAuthHeaderTestResult(null);
    setValues((v) => ({
      ...v,
      auth_headers: [
        ...v.auth_headers,
        {
          // Later rows start unnamed: an empty name is an incomplete row rather
          // than an immediate collision with the first row's default.
          header_name: v.auth_headers.length === 0 ? DEFAULT_AUTH_HEADER_NAME : "",
          value_template: DEFAULT_AUTH_HEADER_TEMPLATE,
          secret_ref: "",
        },
      ],
    }));
  };

  const handleUpdateAuthHeader = (index: number, patch: Partial<WebAuthHeader>) => {
    setAuthHeaderTestResult(null);
    setValues((v) => ({
      ...v,
      auth_headers: v.auth_headers.map((header, position) => {
        if (position !== index) return header;
        const next = { ...header, ...patch };
        // The placeholder and the credential only make sense together, so
        // selecting one adds it and clearing one takes it away. Otherwise the
        // scheme-only default would be a dead end, or a cleared row would keep a
        // marker with nothing to substitute.
        if (patch.secret_ref && !next.value_template.includes(SECRET_PLACEHOLDER)) {
          const prefix = next.value_template;
          next.value_template = `${prefix}${prefix.endsWith(" ") || prefix === "" ? "" : " "}${SECRET_PLACEHOLDER}`;
        }
        if ("secret_ref" in patch && !patch.secret_ref) {
          next.value_template = next.value_template.split(SECRET_PLACEHOLDER).join("").trimEnd();
        }
        return next;
      }),
    }));
  };

  const handleRemoveAuthHeader = (index: number) => {
    setAuthHeaderTestResult(null);
    setValues((v) => ({
      ...v,
      auth_headers: v.auth_headers.filter((_, position) => position !== index),
    }));
  };

  const handleTestAuthHeaders = async (): Promise<void> => {
    setTestingAuthHeaders(true);
    setAuthHeaderTestResult(null);
    try {
      const preview = buildPreviewPayload(values, isEdit, initial?.source_id);
      const settings = (preview.settings ?? {}) as Record<string, unknown>;
      const response = await fetch(WEB_PREVIEW_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...preview,
          // Fetch only the start URL. `crawl_mode` bounds the crawl instead of
          // `max_pages`, whose limit of 1 stops the spider on its first response
          // and reports that stop as the reason the crawl ended.
          settings: { ...settings, crawl_mode: "single", max_pages: 2 },
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        const detail =
          typeof result?.detail === "string"
            ? result.detail
            : typeof result?.error === "string"
              ? result.error
              : `The request failed (${response.status}).`;
        setAuthHeaderTestResult({ ok: false, message: detail });
        return;
      }
      const items = Array.isArray(result?.items) ? result.items : [];
      if (items.length === 0) {
        setAuthHeaderTestResult({
          ok: false,
          message: "The request succeeded but no page content was returned.",
          credentialHint: true,
        });
        return;
      }
      setAuthHeaderTestResult({
        ok: true,
        message: `Fetched ${items.length} page${items.length === 1 ? "" : "s"} and found content.`,
      });
    } catch (testError) {
      setAuthHeaderTestResult({
        ok: false,
        message:
          testError instanceof Error
            ? testError.message
            : "Could not reach the ingestor to run this test.",
      });
    } finally {
      setTestingAuthHeaders(false);
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
  const implicitSearchAccess =
    ownerAccessRef?.kind === "user" ? [ownerAccessRef] : [];

  // In edit mode, an adopted whole-space source may carry no start_page_url
  // at all (spec 2026-07-21-rag-source-config-db) — fall back to the stored
  // content_kind/whole_space so its scope still renders correctly.
  const confluenceInitial = initial?.source_type === "confluence_space" ? initial : null;
  const confluenceLocator = parseConfluenceLocator(values.start_page_url);
  const confluenceKind: "page" | "folder" | "space" =
    confluenceLocator?.kind ??
    confluenceInitial?.content_kind ??
    (confluenceInitial?.whole_space ? "space" : "page");

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
        <fieldset disabled={isReadOnly} className="space-y-4 py-2">
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
                    const parsed = parseConfluenceLocator(startPageUrl);
                    setValues((current) => ({
                      ...current,
                      start_page_url: startPageUrl,
                      confluence_url: parsed?.baseUrl ?? "",
                      space_key: parsed?.spaceKey ?? "",
                    }));
                  }}
                  disabled={isEdit}
                  placeholder="https://example.atlassian.net/wiki/spaces/ENG/pages/123/Overview"
                />
                {!isEdit && values.start_page_url.trim() && !confluenceLocator ? (
                  <p className="text-xs text-destructive">
                    Couldn&apos;t recognize this as a Confluence page, folder,
                    or space URL.
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {confluenceLocator
                      ? `Space: ${confluenceLocator.spaceKey}`
                      : "Paste a page, folder, or space URL. Its space key and scope are detected automatically."}
                  </p>
                )}
              </div>
              {confluenceKind === "page" ? (
                <BoolToggle
                  label="Include child pages"
                  checked={values.get_child_pages}
                  disabled={saving || !ingestorLimits.confluence.allow_child_pages}
                  onChange={(checked) =>
                    setValues((v) => ({ ...v, get_child_pages: checked }))
                  }
                />
              ) : (
                <p className="text-xs text-muted-foreground">
                  {confluenceKind === "folder"
                    ? "Every page nested under this folder, including subfolders, will be ingested."
                    : "Every page in this space will be ingested."}
                </p>
              )}
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
              <AdvancedSettings title="Advanced web crawl settings">
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
                  {credentialsEnabled && (
                    <div className="space-y-3 pt-1">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <p className="text-sm font-medium">Request headers</p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            Most sites need none of these. Add one to send a fixed value,
                            or attach a saved credential when the site requires sign-in.
                            A credential value is never stored with this source: the
                            ingestion service reads it on each crawl, and loses access
                            when you remove the header or delete the source.
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="gap-1"
                          disabled={
                            saving || values.auth_headers.length >= MAX_AUTH_HEADERS
                          }
                          onClick={handleAddAuthHeader}
                        >
                          <Plus className="h-4 w-4" />
                          Add header
                        </Button>
                      </div>

                      {values.auth_headers.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          No headers. Public sites do not need one.
                        </p>
                      ) : (
                        <div className="space-y-3">
                          <div className="hidden gap-2 md:grid md:grid-cols-[1fr_1.5fr_1fr_auto]">
                            <Label className="text-xs text-muted-foreground">
                              Header name
                            </Label>
                            <Label className="text-xs text-muted-foreground">Value</Label>
                            <Label className="text-xs text-muted-foreground">
                              Credential
                            </Label>
                            <span className="w-10" aria-hidden="true" />
                          </div>
                          {values.auth_headers.map((header, index) => {
                            const selectedSecret = secretOptions.find(
                              (secret) => secret.id === header.secret_ref,
                            );
                            const isDuplicate = duplicateAuthHeaders.has(index);
                            return (
                              <div
                                key={index}
                                className="grid gap-2 md:grid-cols-[1fr_1.5fr_1fr_auto]"
                              >
                                <div className="space-y-1">
                                  <Input
                                    aria-label="Header name"
                                    aria-invalid={isDuplicate}
                                    value={header.header_name}
                                    onChange={(e) =>
                                      handleUpdateAuthHeader(index, {
                                        header_name: e.target.value,
                                      })
                                    }
                                    placeholder="Authorization"
                                  />
                                  {isDuplicate && (
                                    <p className="text-xs text-destructive">
                                      Another header above already uses this name. Header
                                      names must be unique.
                                    </p>
                                  )}
                                </div>
                                <div className="space-y-1">
                                  <InlineTokenEditor
                                    ariaLabel="Header value template"
                                    value={header.value_template}
                                    onChange={(value_template) =>
                                      handleUpdateAuthHeader(index, { value_template })
                                    }
                                    token={SECRET_PLACEHOLDER}
                                    tokenLabel={secretTokenLabel(selectedSecret)}
                                    suggestion={
                                      selectedSecret
                                        ? { label: secretTokenLabel(selectedSecret), description: selectedSecret.name }
                                        : undefined
                                    }
                                    placeholder={DEFAULT_AUTH_HEADER_TEMPLATE}
                                    disabled={saving}
                                    invalid={
                                      Boolean(selectedSecret) &&
                                      !header.value_template.includes(SECRET_PLACEHOLDER)
                                    }
                                  />
                                  {selectedSecret &&
                                    !header.value_template.includes(SECRET_PLACEHOLDER) && (
                                      <p className="text-xs text-amber-700 dark:text-amber-400">
                                        Type $ to put the credential back.
                                      </p>
                                    )}
                                </div>
                                <div className="space-y-1">
                                  <SearchablePicker
                                    options={secretOptions}
                                    selected={selectedSecret}
                                    onSelect={(secret) =>
                                      handleUpdateAuthHeader(index, { secret_ref: secret.id })
                                    }
                                    getOptionKey={(secret) => secret.id}
                                    getOptionLabel={(secret) => secret.name}
                                    getSearchText={(secret) => [secret.id, secret.name]}
                                    onClear={() =>
                                      handleUpdateAuthHeader(index, { secret_ref: undefined })
                                    }
                                    clearLabel="Clear credential"
                                    placeholder={
                                      secretOptions.length === 0 ? "No saved credentials" : "None"
                                    }
                                    searchPlaceholder="Search credentials..."
                                    emptyLabel="No credentials match"
                                    ariaLabel="Credential"
                                    loading={secretsLoading}
                                    disabled={saving || secretOptions.length === 0}
                                    triggerClassName="h-9 text-sm"
                                  />
                                </div>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  aria-label="Remove header"
                                  disabled={saving}
                                  onClick={() => handleRemoveAuthHeader(index)}
                                >
                                  <X className="h-4 w-4" />
                                </Button>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {authHeaderPreviewLines.length > 0 && (
                        <div className="space-y-1">
                          <Label className="text-xs text-muted-foreground">
                            Request the crawler will send
                          </Label>
                          <pre
                            data-testid="auth-header-request-preview"
                            className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs leading-relaxed text-muted-foreground"
                          >
                            {authHeaderPreviewLines.join("\n")}
                          </pre>
                          {unsentAuthHeaderCount > 0 && (
                            <p className="text-xs text-muted-foreground">
                              {unsentAuthHeaderCount === 1
                                ? "1 incomplete header is not sent."
                                : `${unsentAuthHeaderCount} incomplete headers are not sent.`}
                            </p>
                          )}
                        </div>
                      )}

                      {values.auth_headers.length > 0 && (
                        <>
                          <div className="flex flex-wrap items-center gap-3">
                            <TooltipProvider delayDuration={150}>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="gap-2"
                                    disabled={
                                      saving ||
                                      testingAuthHeaders ||
                                      hasAuthHeaderConflict ||
                                      !identityFieldsValid(values) ||
                                      sentAuthHeaders.length === 0
                                    }
                                    onClick={() => void handleTestAuthHeaders()}
                                  >
                                    {testingAuthHeaders ? (
                                      <Loader2 className="h-4 w-4 animate-spin" />
                                    ) : (
                                      <Eye className="h-4 w-4" />
                                    )}
                                    {testingAuthHeaders ? "Testing…" : "Test headers"}
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent side="top" sideOffset={8}>
                                  Fetches a single page with these headers.
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                            {values.auth_headers.length >= MAX_AUTH_HEADERS && (
                              <p className="text-xs text-muted-foreground">
                                Maximum of {MAX_AUTH_HEADERS} headers reached.
                              </p>
                            )}
                          </div>
                          {authHeaderTestResult && (
                            <div
                              aria-live="polite"
                              className={cn(
                                "space-y-1 rounded-md border p-2 text-xs",
                                authHeaderTestResult.ok
                                  ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300"
                                  : "border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-300",
                              )}
                            >
                              <p>{authHeaderTestResult.message}</p>
                              {authHeaderTestResult.credentialHint && (
                                <p>{CREDENTIAL_FAILURE_HINT}</p>
                              )}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
              </AdvancedSettings>
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

              {previewError && (
                <p
                  aria-live="polite"
                  className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive"
                >
                  {previewError}
                </p>
              )}

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

          <AdvancedSettings contentClassName="grid gap-3 sm:grid-cols-3">
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
          </AdvancedSettings>

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
                implicitSelectionLabel="Included through ownership"
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
            footer={
              usesCredential ? (
                <div className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400">
                  <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <p>
                    This source is crawled with a saved credential, so it may hold
                    content that is not public. Anyone you give Owner or Search access
                    to can read what was gathered, and it is your responsibility to be
                    sure they should see it.
                  </p>
                </div>
              ) : undefined
            }
          />
        </fieldset>

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
              {isReadOnly ? "Close" : "Cancel"}
            </Button>
          )}
          {!isReadOnly && (
            <Button
              onClick={() => {
                if (needsCredentialSharingConfirm) {
                  setCredentialSharingPrompt(true);
                  return;
                }
                void handleSave();
              }}
              disabled={saving || !canSave}
            >
              {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {isEdit ? "Save Changes" : displayMode === "inline" ? "Ingest Source" : "Create Source"}
            </Button>
          )}
        </DialogFooter>

        {credentialSharingPrompt && (
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Confirm sharing a credentialed source"
            className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
          >
            <div className="w-full max-w-md space-y-4 rounded-2xl border border-border bg-card p-5 shadow-2xl">
              <div className="flex items-start gap-3">
                <Lock
                  className="mt-0.5 h-5 w-5 shrink-0 text-amber-500"
                  aria-hidden="true"
                />
                <div className="space-y-1">
                  <h3 className="text-sm font-semibold">
                    Share content gathered with a credential?
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    This source is crawled with a saved credential, so it may hold
                    content that is not public. Everyone you grant Owner or Search
                    access to will be able to read what was gathered, and it is your
                    responsibility to be sure they should see it.
                  </p>
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setCredentialSharingPrompt(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    setCredentialSharingConfirmed(true);
                    setCredentialSharingPrompt(false);
                    void handleSave();
                  }}
                >
                  Confirm and save
                </Button>
              </div>
            </div>
          </div>
        )}
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
          <DialogTitle>
            {isReadOnly
              ? "View Datasource"
              : isEdit
                ? "Manage Datasource"
                : "New Ingestion Source"}
          </DialogTitle>
          <DialogDescription>
            {isReadOnly
              ? "This datasource is managed in app-config.yaml and is view only."
              : isEdit
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
