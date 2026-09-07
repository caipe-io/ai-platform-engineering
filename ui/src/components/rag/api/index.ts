/**
 * RAG API Client - Ported from RAG WebUI
 *
 * This is a direct port of the RAG webui API client, adapted to use
 * fetch through the Next.js API proxy instead of axios.
 *
 * All requests go through /api/rag/* which proxies to the RAG server.
 */

import { DataSourceInfo, IngestionJob, IngestorInfo } from "../Models";
import type {
  GraphEntity,
  GraphNeighborhoodResponse,
  GraphRelation,
  RelationEvaluationsResponse,
  RelationHeuristicsResponse,
} from "../graph/shared/graphTypes";

// API configuration - uses Next.js API proxy
const API_BASE = "/api/rag";

// Helper function for API calls (replaces axios)
async function apiGet<T>(
  endpoint: string,
  params?: Record<string, string | number>,
): Promise<T> {
  let url = `${API_BASE}${endpoint}`;
  if (params) {
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      searchParams.append(key, String(value));
    });
    url += `?${searchParams.toString()}`;
  }
  const response = await fetch(url);
  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ error: "Request failed" }));
    throw new Error(error.error || error.detail || `HTTP ${response.status}`);
  }
  if (response.status === 204) return {} as T;
  return response.json();
}

async function apiPost<T>(
  endpoint: string,
  data?: unknown,
  params?: Record<string, string>,
): Promise<T> {
  let url = `${API_BASE}${endpoint}`;
  if (params) {
    const searchParams = new URLSearchParams(params);
    url += `?${searchParams.toString()}`;
  }
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: data ? JSON.stringify(data) : undefined,
  });
  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ error: "Request failed" }));
    throw new Error(error.error || error.detail || `HTTP ${response.status}`);
  }
  if (response.status === 204) return {} as T;
  return response.json();
}

async function apiPostForm<T>(endpoint: string, data: FormData): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    method: "POST",
    body: data,
  });
  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ error: "Request failed" }));
    throw new Error(error.error || error.detail || `HTTP ${response.status}`);
  }
  if (response.status === 204) return {} as T;
  return response.json();
}

async function apiPatch<T>(endpoint: string, data?: unknown): Promise<T> {
  const url = `${API_BASE}${endpoint}`;
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: data ? JSON.stringify(data) : undefined,
  });
  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ error: "Request failed" }));
    throw new Error(error.error || error.detail || `HTTP ${response.status}`);
  }
  if (response.status === 204) return {} as T;
  return response.json();
}

async function apiDelete<T>(
  endpoint: string,
  params?: Record<string, string>,
): Promise<T> {
  let url = `${API_BASE}${endpoint}`;
  if (params) {
    const searchParams = new URLSearchParams(params);
    url += `?${searchParams.toString()}`;
  }
  const response = await fetch(url, { method: "DELETE" });
  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ error: "Request failed" }));
    throw new Error(error.error || error.detail || `HTTP ${response.status}`);
  }
  if (response.status === 204) return {} as T;
  return response.json();
}

// ============================================================================
// Health & Configuration
// ============================================================================

export interface RagHealthStatus {
  config?: {
    cleanup?: {
      enabled: boolean;
      interval_seconds: number;
      last_cleanup: number | null;
    };
    graph_rag_enabled?: boolean;
    search?: {
      filter_keys?: Array<{ key: string; type: string }>;
      keys?: string[];
      supported_doc_types?: string[];
    };
  };
  status?: string;
  [key: string]: unknown;
}

export const getHealthStatus = async (): Promise<RagHealthStatus> => {
  return apiGet("/healthz");
};

// ============================================================================
// Data Sources API
// ============================================================================

export const getDataSources = async (): Promise<{
  success: boolean;
  datasources: DataSourceInfo[];
  count: number;
}> => {
  return apiGet("/v1/datasources");
};

export const deleteDataSource = async (datasourceId: string): Promise<void> => {
  return apiDelete("/v1/datasource", { datasource_id: datasourceId });
};

export const renameDataSource = async (
  datasourceId: string,
  name: string,
): Promise<{ datasource_id: string; name: string; changed: boolean }> => {
  return apiPatch(`/v1/datasource/${encodeURIComponent(datasourceId)}`, {
    name,
  });
};

// Cleanup response type
export interface CleanupResponse {
  datasource_id: string | null;
  success: boolean;
  message: string;
}

export const cleanupDataSource = async (
  datasourceId: string,
): Promise<CleanupResponse> => {
  return apiPost(`/v1/datasource/${encodeURIComponent(datasourceId)}/cleanup`);
};

// ScrapySettings interface for web scraping configuration
export interface ScrapySettings {
  crawl_mode: "single" | "sitemap" | "recursive";
  max_depth?: number;
  max_pages?: number;
  render_javascript?: boolean;
  wait_for_selector?: string | null;
  page_load_timeout?: number;
  follow_external_links?: boolean;
  allowed_url_patterns?: string[] | null;
  denied_url_patterns?: string[] | null;
  download_delay?: number;
  concurrent_requests?: number;
  respect_robots_txt?: boolean;
  chunk_size?: number;
  chunk_overlap?: number;
  user_agent?: string | null;
  allow_non_public_urls?: boolean;
}

export const ingestUrl = async (params: {
  url: string;
  description?: string;
  ingest_type?: string;
  get_child_pages?: boolean;
  settings?: ScrapySettings;
  reload_interval: number;
  // Optional management owner. Leaving it unset creates a personal source;
  // selecting a team additionally requires membership in an author-enabled
  // team. Search Access is independent below.
  owner_team_slug?: string;
  search_team_slugs?: string[];
}): Promise<{
  datasource_id: string | null;
  job_id: string | null;
  message: string;
}> => {
  // Route to appropriate endpoint based on ingest_type
  if (params.ingest_type === "confluence") {
    return apiPost("/v1/ingest/confluence/page", {
      url: params.url,
      description: params.description || "",
      get_child_pages: params.get_child_pages || false,
      reload_interval: params.reload_interval,
      owner_team_slug: params.owner_team_slug || null,
      search_team_slugs: params.search_team_slugs ?? [],
    });
  } else {
    // Web ingestion with ScrapySettings and a per-datasource reload interval
    return apiPost("/v1/ingest/webloader/url", {
      url: params.url,
      description: params.description || "",
      settings: params.settings || { crawl_mode: "single" },
      reload_interval: params.reload_interval,
      owner_team_slug: params.owner_team_slug || null,
      search_team_slugs: params.search_team_slugs ?? [],
    });
  }
};

export const ingestLocalFile = async (params: {
  files: File[];
  description?: string;
  owner_team_slug?: string;
  search_team_slugs?: string[];
  chunk_size?: number;
  chunk_overlap?: number;
}): Promise<{
  datasource_id: string | null;
  job_id: string | null;
  message: string;
  _publication_request?: { id: string; status: "pending"; reason?: string };
}> => {
  const form = new FormData();
  params.files.forEach((file) => form.append("file", file));
  if (params.description) form.append("description", params.description);
  if (params.owner_team_slug)
    form.append("owner_team_slug", params.owner_team_slug);
  params.search_team_slugs?.forEach((slug) =>
    form.append("search_team_slugs", slug),
  );
  if (params.chunk_size !== undefined)
    form.append("chunk_size", String(params.chunk_size));
  if (params.chunk_overlap !== undefined)
    form.append("chunk_overlap", String(params.chunk_overlap));
  return apiPostForm("/v1/ingest/local-file", form);
};

export const reuploadLocalFile = async (
  datasourceId: string,
  files: File[],
  chunkSize?: number,
  chunkOverlap?: number,
): Promise<{
  datasource_id: string;
  job_id: string;
  message: string;
}> => {
  const form = new FormData();
  form.append("datasource_id", datasourceId);
  files.forEach((file) => form.append("file", file));
  if (chunkSize !== undefined) form.append("chunk_size", String(chunkSize));
  if (chunkOverlap !== undefined)
    form.append("chunk_overlap", String(chunkOverlap));
  return apiPostForm("/v1/ingest/local-file/reupload", form);
};

export const reloadDataSource = async (
  datasourceId: string,
): Promise<{ datasource_id: string; message: string }> => {
  // Determine endpoint based on datasource ID pattern
  if (datasourceId.includes("src_confluence___")) {
    return apiPost("/v1/ingest/confluence/reload", {
      datasource_id: datasourceId,
    });
  }
  if (datasourceId.startsWith("slack-channel-")) {
    return apiPost("/v1/ingest/slack/reload", { datasource_id: datasourceId });
  }
  if (datasourceId.startsWith("jira-")) {
    return apiPost("/v1/ingest/jira/reload", { datasource_id: datasourceId });
  }
  if (datasourceId.startsWith("webex-space-")) {
    return apiPost("/v1/ingest/webex/reload", { datasource_id: datasourceId });
  }
  return apiPost("/v1/ingest/webloader/reload", {
    datasource_id: datasourceId,
  });
};

// ============================================================================
// Documents API
// ============================================================================

export interface ChunkInfo {
  id: string;
  chunk_index: number;
  total_chunks: number;
  metadata: {
    fresh_until?: number;
    document_type?: string;
    document_ingested_at?: number;
    is_structured_entity?: boolean;
    source?: string;
    [key: string]: unknown;
  };
}

export interface DocumentInfo {
  document_id: string;
  title: string;
  chunks: ChunkInfo[];
}

export interface DatasourceDocumentsResponse {
  datasource_id: string;
  documents: DocumentInfo[];
  total_documents: number;
  total_chunks: number;
  offset: number;
  limit: number;
  has_more: boolean;
}

export interface ChunkContentResponse {
  id: string;
  text_content: string;
}

export const getDatasourceDocuments = async (
  datasourceId: string,
  offset: number = 0,
  limit: number = 100,
): Promise<DatasourceDocumentsResponse> => {
  return apiGet(
    `/v1/datasource/${encodeURIComponent(datasourceId)}/documents`,
    { offset, limit },
  );
};

export const getChunkContent = async (
  chunkId: string,
): Promise<ChunkContentResponse> => {
  return apiGet(`/v1/chunk/${encodeURIComponent(chunkId)}/content`);
};

// ============================================================================
// Jobs API
// ============================================================================

export const getJobStatus = async (jobId: string): Promise<IngestionJob> => {
  return apiGet(`/v1/job/${jobId}`);
};

export const getJobsByDataSource = async (
  datasourceId: string,
): Promise<IngestionJob[]> => {
  return apiGet(`/v1/jobs/datasource/${datasourceId}`);
};

export const terminateJob = async (jobId: string): Promise<void> => {
  return apiPost(`/v1/job/${jobId}/terminate`);
};

export interface JobsBatchResponse {
  jobs: Record<string, IngestionJob[]>;
  total_jobs: number;
  datasource_count: number;
}

export const getJobsBatch = async (
  datasourceIds: string[],
  statusFilter?: string[],
): Promise<JobsBatchResponse> => {
  return apiPost("/v1/jobs/batch", {
    datasource_ids: datasourceIds,
    status_filter: statusFilter,
  });
};

// ============================================================================
// MCP Tools API
// ============================================================================

// MCP Tool Schema types
export interface MCPToolParameter {
  type: string;
  description?: string;
  default?: unknown;
  enum?: string[];
  items?: { type: string };
  properties?: Record<string, MCPToolParameter>;
  required?: string[];
}

export interface MCPToolSchema {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, MCPToolParameter>;
    required?: string[];
  };
}

export interface MCPToolSchemasResponse {
  tools: MCPToolSchema[];
  count: number;
}

export interface MCPToolInvokeResponse {
  tool_name: string;
  success: boolean;
  result: unknown;
  error: string | null;
}

/**
 * Get all registered MCP tools with their full JSON schemas.
 */
export const getMCPToolSchemas = async (): Promise<MCPToolSchemasResponse> => {
  return apiGet("/v1/mcp/tools/schema");
};

/**
 * Invoke an MCP tool via REST API.
 */
export const invokeMCPTool = async (
  toolName: string,
  args: Record<string, unknown>,
): Promise<MCPToolInvokeResponse> => {
  return apiPost("/v1/mcp/invoke", {
    tool_name: toolName,
    arguments: args,
  });
};

// ============================================================================
// Ingestors API
// ============================================================================

export const getIngestors = async (): Promise<IngestorInfo[]> => {
  return apiGet("/v1/ingestors");
};

export const deleteIngestor = async (ingestorId: string): Promise<void> => {
  return apiDelete("/v1/ingestor/delete", { ingestor_id: ingestorId });
};

// ============================================================================
// Ontology Graph API
// ============================================================================

export const getOntologyEntities = async (
  filterProps: Record<string, unknown> = {},
): Promise<GraphEntity[]> => {
  return apiPost("/v1/graph/explore/ontology/entities", {
    entity_type: null,
    filter_by_properties: filterProps,
  });
};

export const getOntologyRelations = async (
  filterProps: Record<string, unknown> = {},
): Promise<GraphRelation[]> => {
  return apiPost("/v1/graph/explore/ontology/relations", {
    from_type: null,
    to_type: null,
    relation_name: null,
    filter_by_properties: filterProps,
  });
};

export const getEntityTypes = async (): Promise<string[]> => {
  return apiGet("/v1/graph/explore/entity_type");
};

// ============================================================================
// Ontology Agent API
// ============================================================================

export const getOntologyAgentStatus = async () => {
  return apiGet("/v1/graph/ontology/agent/status");
};

export const regenerateOntology = async (): Promise<void> => {
  return apiPost("/v1/graph/ontology/agent/regenerate_ontology");
};

export const clearOntology = async (): Promise<void> => {
  return apiDelete("/v1/graph/ontology/agent/clear");
};

export const getOntologyVersion = async () => {
  return apiGet("/v1/graph/ontology/agent/ontology_version");
};

// ============================================================================
// Ontology and Data Graph Neighborhood Exploration API
// ============================================================================

export const getOntologyStartNodes = async (
  n: number = 10,
): Promise<GraphEntity[]> => {
  return apiGet("/v1/graph/explore/ontology/entity/start", { n });
};

export const getDataStartNodes = async (
  n: number = 10,
): Promise<GraphEntity[]> => {
  return apiGet("/v1/graph/explore/data/entity/start", { n });
};

export const exploreOntologyNeighborhood = async (
  entityType: string,
  entityPk: string,
  depth: number = 1,
): Promise<GraphNeighborhoodResponse> => {
  return apiPost("/v1/graph/explore/ontology/entity/neighborhood", {
    entity_type: entityType,
    entity_pk: entityPk,
    depth: depth,
  });
};

export const exploreDataNeighborhood = async (
  entityType: string,
  entityPk: string,
  depth: number = 1,
): Promise<GraphNeighborhoodResponse> => {
  return apiPost("/v1/graph/explore/data/entity/neighborhood", {
    entity_type: entityType,
    entity_pk: entityPk,
    depth: depth,
  });
};

export const getOntologyGraphStats = async (): Promise<{
  node_count: number;
  relation_count: number;
}> => {
  return apiGet("/v1/graph/explore/ontology/stats");
};

export const getDataGraphStats = async (): Promise<{
  node_count: number;
  relation_count: number;
}> => {
  return apiGet("/v1/graph/explore/data/stats");
};

// ============================================================================
// Graph Batch Fetch API
// ============================================================================

export const fetchOntologyEntitiesBatch = async (params: {
  offset?: number;
  limit?: number;
  entity_type?: string;
}): Promise<{
  entities: GraphEntity[];
  count: number;
  offset: number;
  limit: number;
}> => {
  const queryParams: Record<string, string> = {};
  if (params.offset !== undefined) queryParams.offset = String(params.offset);
  if (params.limit !== undefined) queryParams.limit = String(params.limit);
  if (params.entity_type) queryParams.entity_type = params.entity_type;
  return apiGet("/v1/graph/explore/ontology/entities/batch", queryParams);
};

export const fetchOntologyRelationsBatch = async (params: {
  offset?: number;
  limit?: number;
  relation_name?: string;
}): Promise<{
  relations: GraphRelation[];
  count: number;
  offset: number;
  limit: number;
}> => {
  const queryParams: Record<string, string> = {};
  if (params.offset !== undefined) queryParams.offset = String(params.offset);
  if (params.limit !== undefined) queryParams.limit = String(params.limit);
  if (params.relation_name) queryParams.relation_name = params.relation_name;
  return apiGet("/v1/graph/explore/ontology/relations/batch", queryParams);
};

export const fetchDataEntitiesBatch = async (params: {
  offset?: number;
  limit?: number;
  entity_type?: string;
}): Promise<{
  entities: GraphEntity[];
  count: number;
  offset: number;
  limit: number;
}> => {
  const queryParams: Record<string, string> = {};
  if (params.offset !== undefined) queryParams.offset = String(params.offset);
  if (params.limit !== undefined) queryParams.limit = String(params.limit);
  if (params.entity_type) queryParams.entity_type = params.entity_type;
  return apiGet("/v1/graph/explore/data/entities/batch", queryParams);
};

export const fetchDataRelationsBatch = async (params: {
  offset?: number;
  limit?: number;
  relation_name?: string;
}): Promise<{
  relations: GraphRelation[];
  count: number;
  offset: number;
  limit: number;
}> => {
  const queryParams: Record<string, string> = {};
  if (params.offset !== undefined) queryParams.offset = String(params.offset);
  if (params.limit !== undefined) queryParams.limit = String(params.limit);
  if (params.relation_name) queryParams.relation_name = params.relation_name;
  return apiGet("/v1/graph/explore/data/relations/batch", queryParams);
};

// ============================================================================
// Ontology Relation Management API
// ============================================================================

export const acceptOntologyRelation = async (
  relationId: string,
  relationName: string,
  propertyMappings: Array<{
    entity_a_property: string;
    entity_b_idkey_property: string;
    match_type:
      | "exact"
      | "prefix"
      | "suffix"
      | "subset"
      | "superset"
      | "contains";
  }>,
): Promise<void> => {
  return apiPost(
    `/v1/graph/ontology/agent/relation/accept/${encodeURIComponent(relationId)}`,
    propertyMappings,
    { relation_name: relationName },
  );
};

export const rejectOntologyRelation = async (
  relationId: string,
  justification: string = "Rejected by user",
): Promise<void> => {
  return apiPost(
    `/v1/graph/ontology/agent/relation/reject/${encodeURIComponent(relationId)}`,
    undefined,
    { justification },
  );
};

export const undoOntologyRelationEvaluation = async (
  relationId: string,
): Promise<void> => {
  return apiPost(
    `/v1/graph/ontology/agent/relation/undo_evaluation/${encodeURIComponent(relationId)}`,
  );
};

export const evaluateOntologyRelation = async (
  relationId: string,
): Promise<void> => {
  return apiPost(
    `/v1/graph/ontology/agent/relation/evaluate/${encodeURIComponent(relationId)}`,
  );
};

export const syncOntologyRelation = async (
  relationId: string,
): Promise<void> => {
  return apiPost(
    `/v1/graph/ontology/agent/relation/sync/${encodeURIComponent(relationId)}`,
  );
};

export const getOntologyRelationHeuristicsBatch = async (
  relationIds: string[],
): Promise<RelationHeuristicsResponse> => {
  return apiPost(
    "/v1/graph/ontology/agent/relation/heuristics/batch",
    relationIds,
  );
};

export const getOntologyRelationEvaluationsBatch = async (
  relationIds: string[],
): Promise<RelationEvaluationsResponse> => {
  return apiPost(
    "/v1/graph/ontology/agent/relation/evaluations/batch",
    relationIds,
  );
};

// ============================================================================
// Debug/Development API
// ============================================================================

export const processEntityForHeuristics = async (
  entityType: string,
  primaryKeyValue: string,
): Promise<void> => {
  return apiPost("/v1/graph/ontology/agent/debug/process", null, {
    entity_type: entityType,
    primary_key_value: primaryKeyValue,
  });
};

export const cleanupOntologyRelations = async (): Promise<void> => {
  return apiPost("/v1/graph/ontology/agent/debug/cleanup");
};

// ============================================================================
// Aliases for graph components
// ============================================================================

// Alias for batch fetch functions (used by graph components)
export const getOntologyEntitiesBatch = fetchOntologyEntitiesBatch;
export const getOntologyRelationsBatch = fetchOntologyRelationsBatch;
export const exploreEntityNeighborhood = exploreDataNeighborhood;
