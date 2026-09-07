import type { DataSourceInfo } from "./Models";
import type { IngestionSourceConfigWithPermissions } from "@/types/ingestion-source";
import type { RagCollectionMembershipLabel } from "@/types/rag-collection";

export const DEFAULT_INGEST_TYPE = "file";

const INGEST_TYPES = new Set([
  "file",
  "web",
  "slack",
  "confluence",
  "jira",
  "webex",
]);

export interface DatasourceViewState {
  ingestType: string;
  sourceTypes: string[];
  owners: string[];
  searchAccess: string[];
  query: string;
  page: number;
}

export interface DatasourceFilterProjection {
  sourceType: string;
  owner: string | null;
  searchAccess: string[];
  searchableText: string;
}

interface SearchParamsReader {
  get(name: string): string | null;
  getAll(name: string): string[];
}

function unique(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

export function effectiveSearchTeamSlugs(input: {
  searchTeamSlugs?: readonly string[] | null;
  ragCollections?: readonly RagCollectionMembershipLabel[] | null;
}): string[] {
  return unique([
    ...(input.searchTeamSlugs ?? []),
    ...(input.ragCollections ?? []).flatMap(
      (collection) => collection.reader_team_slugs ?? [],
    ),
  ]);
}

export function searchTeamLabel(teamSlug: string): string {
  return teamSlug.toLowerCase() === "everyone" ? "Everyone" : teamSlug;
}

export function searchAccessFilterLabel(value: string): string {
  return value.toLowerCase() === "team: everyone" ? "Team: Everyone" : value;
}

export function normalizeDatasourceType(sourceType: string): string {
  const value = sourceType.trim().toLowerCase();
  if (value.includes("local") || value === "file") return "file";
  if (value.startsWith("webex")) return "webex";
  if (value.startsWith("web")) return "web";
  if (value.startsWith("slack")) return "slack";
  if (value.startsWith("confluence")) return "confluence";
  if (value.startsWith("jira")) return "jira";
  return value;
}

export function datasourceTypeLabel(sourceType: string): string {
  const normalized = normalizeDatasourceType(sourceType);
  const labels: Record<string, string> = {
    file: "File",
    web: "Web",
    slack: "Slack",
    confluence: "Confluence",
    jira: "Jira",
    webex: "Webex",
  };
  return labels[normalized] ?? normalized.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function ownerFilterValue(input: {
  ownerTeamSlug?: string | null;
  ownerSubject?: string | null;
  ownerDisplayName?: string | null;
}): string | null {
  const team = input.ownerTeamSlug?.trim();
  if (team) return `Team: ${team}`;
  const subject = input.ownerSubject?.trim();
  const displayName = input.ownerDisplayName?.trim();
  if (subject && displayName) return `Person: ${displayName}`;
  return null;
}

export function searchAccessFilterValues(input: {
  ownerTeamSlug?: string | null;
  ownerSubject?: string | null;
  ownerDisplayName?: string | null;
  searchTeamSlugs?: readonly string[] | null;
  searchUserDisplayNames?: readonly string[] | null;
  ragCollections?: readonly RagCollectionMembershipLabel[] | null;
}): string[] {
  const effectiveTeams = effectiveSearchTeamSlugs({
    searchTeamSlugs: input.searchTeamSlugs,
    ragCollections: input.ragCollections,
  });
  const values = [
    ...(input.ownerSubject && !input.ownerTeamSlug && input.ownerDisplayName
      ? [`Person: ${input.ownerDisplayName.trim()}`]
      : []),
    ...effectiveTeams.map((slug) => `Team: ${slug}`),
    ...(input.searchUserDisplayNames ?? []).map((name) => `Person: ${name.trim()}`),
  ];
  return unique(values);
}

export function dataSourceFilterProjection(
  datasource: DataSourceInfo,
  source?: IngestionSourceConfigWithPermissions,
): DatasourceFilterProjection {
  const ownerTeamSlug = source?.owner_team_slug ?? datasource.owner_team_slug;
  const ownerSubject = source?.owner_subject ?? datasource.owner_subject;
  const ownerDisplayName = source?.owner_display_name ?? datasource.owner_display_name;
  const searchTeamSlugs = source?.search_with_teams
    ?? (source?.search_owner_team_slug
      ? [source.search_owner_team_slug]
      : datasource.search_with_teams);
  const searchUserDisplayNames = source?.search_user_display_names
    ?? datasource.search_user_display_names;

  return {
    sourceType: normalizeDatasourceType(datasource.source_type),
    owner: ownerFilterValue({ ownerTeamSlug, ownerSubject, ownerDisplayName }),
    searchAccess: searchAccessFilterValues({
      ownerTeamSlug,
      ownerSubject,
      ownerDisplayName,
      searchTeamSlugs,
      searchUserDisplayNames,
      ragCollections: source?.rag_collections ?? datasource.rag_collections,
    }),
    searchableText: [
      datasource.name,
      datasource.datasource_id,
      datasource.source_type,
      datasource.description,
      datasource.ingestor_id,
    ]
      .filter((value): value is string => Boolean(value))
      .join(" ")
      .toLowerCase(),
  };
}

export function sourceConfigFilterProjection(
  source: IngestionSourceConfigWithPermissions,
): DatasourceFilterProjection {
  return {
    sourceType: normalizeDatasourceType(source.source_type),
    owner: ownerFilterValue({
      ownerTeamSlug: source.owner_team_slug,
      ownerSubject: source.owner_subject,
      ownerDisplayName: source.owner_display_name,
    }),
    searchAccess: searchAccessFilterValues({
      ownerTeamSlug: source.owner_team_slug,
      ownerSubject: source.owner_subject,
      ownerDisplayName: source.owner_display_name,
      searchTeamSlugs: source.search_with_teams
        ?? (source.search_owner_team_slug ? [source.search_owner_team_slug] : []),
      searchUserDisplayNames: source.search_user_display_names,
      ragCollections: source.rag_collections,
    }),
    searchableText: [source.name, source.source_id, source.source_type, source.description]
      .filter((value): value is string => Boolean(value))
      .join(" ")
      .toLowerCase(),
  };
}

export function matchesDatasourceFilters(
  projection: DatasourceFilterProjection,
  state: DatasourceViewState,
): boolean {
  if (state.sourceTypes.length > 0 && !state.sourceTypes.includes(projection.sourceType)) {
    return false;
  }
  if (state.owners.length > 0 && (!projection.owner || !state.owners.includes(projection.owner))) {
    return false;
  }
  if (
    state.searchAccess.length > 0 &&
    !projection.searchAccess.some((access) => state.searchAccess.includes(access))
  ) {
    return false;
  }
  const query = state.query.trim().toLowerCase();
  return !query || projection.searchableText.includes(query);
}

export function parseDatasourceViewState(params: SearchParamsReader): DatasourceViewState {
  const requestedIngestType = params.get("ingest")?.trim().toLowerCase();
  const rawPage = Number.parseInt(params.get("page") ?? "1", 10);
  return {
    ingestType: requestedIngestType && INGEST_TYPES.has(requestedIngestType)
      ? requestedIngestType
      : DEFAULT_INGEST_TYPE,
    sourceTypes: unique(params.getAll("type")).map(normalizeDatasourceType).sort(),
    owners: unique(params.getAll("owner")).sort(),
    searchAccess: unique(params.getAll("access")).sort(),
    query: params.get("q") ?? "",
    page: Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1,
  };
}

export function serializeDatasourceViewState(state: DatasourceViewState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.ingestType !== DEFAULT_INGEST_TYPE) params.set("ingest", state.ingestType);
  for (const sourceType of unique(state.sourceTypes).sort()) params.append("type", sourceType);
  for (const owner of unique(state.owners).sort()) params.append("owner", owner);
  for (const access of unique(state.searchAccess).sort()) params.append("access", access);
  if (state.query.trim()) params.set("q", state.query.trim());
  if (state.page > 1) params.set("page", String(state.page));
  return params;
}

export function sameDatasourceViewState(
  left: DatasourceViewState,
  right: DatasourceViewState,
): boolean {
  return serializeDatasourceViewState(left).toString() === serializeDatasourceViewState(right).toString();
}
