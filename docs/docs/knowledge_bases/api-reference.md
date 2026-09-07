---
sidebar_position: 2
---

<!-- assisted-by Codex Codex-sonnet-4-6 -->

# RAG API Reference

CAIPE RAG exposes a FastAPI REST API for authentication metadata, datasource and ingestion management, job tracking, graph exploration, MCP tool configuration, and MCP tool invocation. It also exposes a native MCP endpoint for agents.

This page is based on `ai_platform_engineering/knowledge_bases/rag/server/src/server/restapi.py` and the shared RAG models.

## Base URLs

| Access path | URL |
|-------------|-----|
| Direct RAG server | `http://localhost:9446` |
| Swagger UI | `http://localhost:9446/docs` |
| OpenAPI JSON | `http://localhost:9446/openapi.json` |
| MCP endpoint | `http://localhost:9446/mcp` |
| Through CAIPE UI BFF | `http://localhost:3000/api/rag/<rag-path>` |

When using the UI BFF, omit the leading slash from the RAG path after `/api/rag/`. For example, direct `GET /v1/user/info` becomes `GET /api/rag/v1/user/info`.

## Authentication and RBAC

RAG supports OIDC bearer tokens and ingestor credentials. The UI BFF forwards the current NextAuth `accessToken` to the RAG server as a bearer token.

Role levels are hierarchical:

| Role | Can do |
|------|--------|
| `readonly` | Query and view data, graph metadata, MCP tool schemas, and invoke MCP tools. |
| `ingestonly` | Everything `readonly` can do, plus datasource upserts, ingestor heartbeats, document ingestion, and job updates. |
| `admin` | Everything `ingestonly` can do, plus deletion, cleanup, ontology-agent writes, MCP tool config writes, and bulk reload/cleanup operations. |

Check the resolved identity and role:

```bash
curl http://localhost:9446/v1/user/info \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

Response:

```json
{
  "email": "user@example.com",
  "role": "readonly",
  "is_authenticated": true,
  "permissions": ["read"]
}
```

Through the UI proxy:

```bash
curl http://localhost:3000/api/rag/v1/user/info
```

## Endpoint Summary

### Identity and Health

| Method | Route | Role | Purpose |
|--------|-------|------|---------|
| `GET` | `/v1/user/info` | Public | Return current identity status, role, and permission strings. |
| `GET` | `/healthz` | Public | Return service health and key runtime configuration. |

### Ingestors and Datasources

| Method | Route | Role | Purpose |
|--------|-------|------|---------|
| `GET` | `/v1/ingestors` | `readonly` | List registered ingestors. |
| `POST` | `/v1/ingestor/heartbeat` | `ingestonly` | Register or refresh an ingestor and receive ingest limits. |
| `DELETE` | `/v1/ingestor/delete?ingestor_id=<id>` | `admin` | Delete an ingestor. |
| `POST` | `/v1/datasource` | `ingestonly` | Upsert datasource metadata. |
| `DELETE` | `/v1/datasource?datasource_id=<id>` | `admin` | Delete a datasource. |
| `POST` | `/v1/datasource/:datasource_id/cleanup` | `admin` | Remove stale documents for one datasource. |
| `POST` | `/v1/datasources/cleanup` | `admin` | Remove stale documents across datasources. |
| `GET` | `/v1/datasources?ingestor_id=<id>` | `readonly` | List datasources, optionally filtered by ingestor. |
| `GET` | `/v1/datasource/:datasource_id/documents` | `readonly` | List documents and chunks for a datasource. Supports pagination. |
| `GET` | `/v1/chunk/:chunk_id/content` | `readonly` | Fetch full chunk content and metadata. |

Ingestor heartbeat body:

```json
{
  "ingestor_type": "web",
  "ingestor_name": "docs-webloader",
  "description": "Documentation crawler",
  "metadata": {
    "owner": "platform-team"
  }
}
```

Datasource body:

```json
{
  "datasource_id": "web:https://docs.example.com",
  "ingestor_id": "web:docs-webloader",
  "description": "Public documentation",
  "source_type": "web",
  "last_updated": 1770000000,
  "default_chunk_size": 10000,
  "default_chunk_overlap": 2000,
  "reload_interval": 86400,
  "metadata": {
    "url": "https://docs.example.com"
  }
}
```

### Jobs

| Method | Route | Role | Purpose |
|--------|-------|------|---------|
| `GET` | `/v1/job/:job_id` | `readonly` | Fetch one ingestion job. |
| `GET` | `/v1/jobs/datasource/:datasource_id?status_filter=<status>` | `readonly` | List jobs for a datasource. |
| `POST` | `/v1/jobs/batch` | `readonly` | Fetch jobs for up to 100 datasource IDs, with optional status filters. |
| `POST` | `/v1/job?datasource_id=<id>&job_status=<status>&message=<msg>&total=<n>` | `ingestonly` | Create an ingestion job. |
| `PATCH` | `/v1/job/:job_id?job_status=<status>&message=<msg>&total=<n>` | `ingestonly` | Update job state. |
| `POST` | `/v1/job/:job_id/terminate` | `admin` | Terminate a job. |
| `POST` | `/v1/job/:job_id/increment-progress?increment=<n>` | `ingestonly` | Increment processed item count. |
| `POST` | `/v1/job/:job_id/increment-failure?increment=<n>` | `ingestonly` | Increment failure count. |
| `POST` | `/v1/job/:job_id/increment-document-count?increment=<n>` | `ingestonly` | Increment document count. |
| `POST` | `/v1/job/:job_id/add-errors` | `ingestonly` | Append job error messages. |

Batch request:

```json
{
  "datasource_ids": ["web:https://docs.example.com", "confluence:SPACE:1234"],
  "status_filter": ["in_progress", "pending"]
}
```

### Ingestion

| Method | Route | Role | Purpose |
|--------|-------|------|---------|
| `POST` | `/v1/ingest/webloader/url` | `ingestonly` | Crawl and ingest a URL. |
| `POST` | `/v1/ingest/webloader/reload` | `ingestonly` | Reload one web datasource. |
| `POST` | `/v1/ingest/webloader/reload-all` | `admin` | Reload all web datasources. |
| `POST` | `/v1/ingest/confluence/page` | `ingestonly` | Ingest a Confluence page, optionally with child pages. |
| `POST` | `/v1/ingest/confluence/reload` | `ingestonly` | Reload one Confluence datasource. |
| `POST` | `/v1/ingest/confluence/reload-all` | `admin` | Reload all Confluence datasources. |
| `POST` | `/v1/ingest` | `ingestonly` | Ingest arbitrary LangChain documents for a datasource. |

Web URL ingestion:

```json
{
  "url": "https://docs.example.com/platform",
  "description": "Platform docs",
  "settings": {
    "crawl_mode": "sitemap",
    "max_depth": 2,
    "max_pages": 500,
    "render_javascript": false,
    "respect_robots_txt": true,
    "chunk_size": 10000,
    "chunk_overlap": 2000
  },
  "reload_interval": 86400
}
```

Confluence ingestion:

```json
{
  "url": "https://example.atlassian.net/wiki/spaces/PLAT/pages/123456/Runbook",
  "description": "Platform runbook",
  "get_child_pages": true,
  "allowed_title_patterns": ["Runbook", "How-to"],
  "denied_title_patterns": ["Archive"],
  "reload_interval": 86400
}
```

Document ingestion:

```json
{
  "ingestor_id": "custom:runbook-loader",
  "datasource_id": "custom:runbooks",
  "job_id": "job-123",
  "fresh_until": 1770000000,
  "documents": [
    {
      "page_content": "Full document text",
      "metadata": {
        "document_id": "runbook-1",
        "title": "Restart service",
        "document_type": "runbook"
      }
    }
  ]
}
```

### Graph Exploration

Graph APIs are available when Graph RAG is enabled.

| Method | Route | Role | Purpose |
|--------|-------|------|---------|
| `GET` | `/v1/graph/explore/entity_type` | `readonly` | List entity types. |
| `GET` | `/v1/graph/explore/data/entities/batch` | `readonly` | Fetch data graph entities in batch. |
| `GET` | `/v1/graph/explore/data/relations/batch` | `readonly` | Fetch data graph relations in batch. |
| `POST` | `/v1/graph/explore/data/entity/neighborhood` | `readonly` | Explore a data entity neighborhood. |
| `GET` | `/v1/graph/explore/data/entity/start?n=10` | `readonly` | Fetch random data graph start nodes. |
| `GET` | `/v1/graph/explore/data/stats` | `readonly` | Fetch data graph stats. |
| `GET` | `/v1/graph/explore/ontology/entities/batch` | `readonly` | Fetch ontology graph entities in batch. |
| `GET` | `/v1/graph/explore/ontology/relations/batch` | `readonly` | Fetch ontology graph relations in batch. |
| `POST` | `/v1/graph/explore/ontology/entity/neighborhood` | `readonly` | Explore an ontology entity neighborhood. |
| `GET` | `/v1/graph/explore/ontology/entity/start?n=10` | `readonly` | Fetch random ontology graph start nodes. |
| `GET` | `/v1/graph/explore/ontology/stats` | `readonly` | Fetch ontology graph stats. |

Neighborhood request:

```json
{
  "entity_type": "Pod",
  "entity_pk": "platform/api-7ccf9",
  "depth": 1
}
```

### Ontology Agent Proxy

When Graph RAG is enabled, the RAG server reverse-proxies ontology-agent routes under `/v1/graph/ontology/agent/*`. Status is read-only; all write operations require admin.

| Method | Route | Role | Purpose |
|--------|-------|------|---------|
| `GET` | `/v1/graph/ontology/agent/status` | `readonly` | Ontology agent health/status. |
| `GET` | `/v1/graph/ontology/agent/ontology_version` | `admin` through proxy policy | Current ontology version. |
| `POST` | `/v1/graph/ontology/agent/relation/accept/:relation_id` | `admin` | Accept a proposed relation. |
| `POST` | `/v1/graph/ontology/agent/relation/reject/:relation_id` | `admin` | Reject a proposed relation. |
| `POST` | `/v1/graph/ontology/agent/relation/undo_evaluation/:relation_id` | `admin` | Undo a relation evaluation. |
| `POST` | `/v1/graph/ontology/agent/relation/evaluate/:relation_id` | `admin` | Evaluate a relation. |
| `POST` | `/v1/graph/ontology/agent/relation/sync/:relation_id` | `admin` | Sync a relation to the ontology graph. |
| `POST` | `/v1/graph/ontology/agent/relation/heuristics/batch` | `admin` | Batch relation heuristics. |
| `POST` | `/v1/graph/ontology/agent/relation/evaluations/batch` | `admin` | Batch relation evaluations. |
| `POST` | `/v1/graph/ontology/agent/regenerate_ontology` | `admin` | Regenerate ontology. |
| `DELETE` | `/v1/graph/ontology/agent/clear` | `admin` | Clear ontology-agent data. |
| `POST` | `/v1/graph/ontology/agent/debug/process_all` | `admin` | Debug process all relations. |
| `POST` | `/v1/graph/ontology/agent/debug/cleanup` | `admin` | Debug cleanup. |

The proxy currently treats only `GET` requests whose path ends in `/status` as read-only; other ontology-agent methods and paths require admin.

### MCP Tool Configuration and Invocation

| Method | Route | Role | Purpose |
|--------|-------|------|---------|
| `GET` | `/v1/mcp/custom-tools` | `readonly` | List custom MCP search tool configs. |
| `POST` | `/v1/mcp/custom-tools` | `admin` | Create a custom MCP search tool. Reserved IDs cannot be created. |
| `PUT` | `/v1/mcp/custom-tools/:tool_id` | `admin` | Update a custom tool or the seeded `search` config. |
| `DELETE` | `/v1/mcp/custom-tools/:tool_id` | `admin` | Delete a custom tool. Reserved IDs cannot be deleted. |
| `GET` | `/v1/mcp/builtin-tools` | `readonly` | Read built-in MCP tool enablement. |
| `PUT` | `/v1/mcp/builtin-tools` | `admin` | Update built-in MCP tool enablement. |
| `GET` | `/v1/mcp/tools/schema` | `readonly` | Return built-in and custom tool parameter schemas. |
| `POST` | `/v1/mcp/invoke` | `readonly` | Invoke an MCP tool via REST. |

Built-in tool IDs are reserved: `search`, `fetch_document`, and `list_datasources_and_entity_types`.

Custom search tool config:

```json
{
  "tool_id": "infra_search",
  "description": "Search infrastructure runbooks and graph entities",
  "parallel_searches": [
    {
      "label": "runbooks",
      "datasource_ids": ["confluence:RUNBOOKS"],
      "extra_filters": {
        "document_type": "runbook"
      },
      "semantic_weight": 0.7
    },
    {
      "label": "kubernetes_entities",
      "datasource_ids": ["k8s:*"],
      "extra_filters": {
        "is_structured_entity": true
      },
      "semantic_weight": 0.5
    }
  ],
  "allow_runtime_filters": true,
  "enabled": true
}
```

Invoke a tool through REST:

```bash
curl -X POST http://localhost:9446/v1/mcp/invoke \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "tool_name": "search",
    "arguments": {
      "query": "How do I recover a stuck ArgoCD sync?",
      "limit": 5,
      "thought": "Find operational runbooks before answering"
    }
  }'
```

Response:

```json
{
  "tool_name": "search",
  "success": true,
  "result": {},
  "error": null
}
```

## MCP Endpoint

Agents can connect directly to:

```text
http://localhost:9446/mcp
```

The MCP server exposes the built-in tools enabled in `/v1/mcp/builtin-tools` plus enabled custom search tools from `/v1/mcp/custom-tools`.

Core built-in tools:

| Tool | Purpose |
|------|---------|
| `search` | Hybrid semantic and keyword search over indexed content. |
| `fetch_document` | Fetch full content for a document ID returned by search. |
| `list_datasources_and_entity_types` | Discover datasources and graph entity types. |

Graph tools are available when Graph RAG is enabled:

| Tool | Purpose |
|------|---------|
| `graph_explore_ontology_entity` | Explore ontology entity type schema and relationships. |
| `graph_explore_data_entity` | Explore one data entity and its neighborhood. |
| `graph_fetch_data_entity_details` | Fetch complete entity properties and relations. |
| `graph_shortest_path_between_entity_types` | Find relation paths between entity types. |
| `graph_raw_query_data` | Execute read-only Cypher against the data graph with tenant-label injection. |
| `graph_raw_query_ontology` | Execute read-only Cypher against the ontology graph with tenant-label injection. |

## UI BFF Proxy Notes

The UI route `GET, POST, PUT, DELETE /api/rag/*path` proxies to the same direct RAG endpoints:

| UI route | Direct RAG route |
|----------|------------------|
| `/api/rag/healthz` | `/healthz` |
| `/api/rag/v1/datasources` | `/v1/datasources` |
| `/api/rag/v1/mcp/invoke` | `/v1/mcp/invoke` |

The proxy forwards query parameters on `GET` and `DELETE`, JSON bodies on `POST` and `PUT`, and the session access token as a bearer token when present.

## Common Status Codes

| Status | Meaning |
|--------|---------|
| `200` | Successful read, update, invocation, or delete. |
| `202` | Ingestion accepted for asynchronous processing. |
| `401` | Missing or invalid authentication. |
| `403` | Authenticated user lacks the required RAG role. |
| `404` | Resource not found. |
| `500` | Server or backing service initialization failure. |
| `502` | UI BFF could not connect to the RAG server. |
