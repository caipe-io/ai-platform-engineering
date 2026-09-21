# MCP tools

The RAG server exposes Model Context Protocol (MCP) tools for search, document
retrieval, and graph exploration. Agents created in Agent Builder and other MCP
clients use the same authorization-aware interface to organizational knowledge.

For configuration details, see the
[RAG server README](https://github.com/caipe-io/ai-platform-engineering/tree/main/ai_platform_engineering/knowledge_bases/rag/server/README.md).

## What is MCP?

MCP is an open standard for connecting AI applications to tools and data sources.
It provides:

- A consistent tool interface for MCP-compatible clients
- Tool discovery so agents can inspect the available capabilities
- Streamable HTTP transport for remote connections

## Connect to CAIPE RAG

The default MCP endpoint is:

```text
http://localhost:9446/mcp
```

Connect over Streamable HTTP. When `MCP_AUTH_ENABLED=true`, the client must send
a valid bearer token. In Agent Builder, register the endpoint as an MCP server
and attach only the tools the agent needs. See [Authentication](authentication-overview.md)
for identity and authorization details.

## Search and fetch pattern

Use search to find relevant content before fetching full documents:

1. **Search** returns short snippets, document IDs, scores, and metadata.
2. **Review** the results to identify relevant documents.
3. **Fetch** the full content for the selected document IDs.

The default snippet limit is 500 characters. This pattern lets agents compare
several results before loading complete documents.

## Available tools

Tool schemas can include `thought`, which records why the agent selected a tool.
They can also include runtime `filters` that narrow the configured data source
scope. Filters never expand the current caller's access.

### Search tools

#### `search`

Hybrid semantic and keyword search across all indexed content.

**Parameters:**

- `query` (required): Search query
- `filters`: Optional metadata filters
- `limit`: Maximum number of results for each configured search (default: `10`)
- `thought`: Reason the agent selected the tool

**Returns:** An object keyed by the configured parallel-search labels. The
default labels are `semantic_results` and `keyword_results`; each contains
snippets, scores, document IDs, and metadata.

Use this tool to find documents, explore a topic, or gather evidence for an answer.

#### `fetch_document`

Retrieve full content of a specific document by ID.

**Parameters:**

- `document_id` (required): Document ID returned by `search`
- `filters`: Optional runtime data source scope
- `thought`: Reason the agent selected the tool

**Returns:** Complete document content and metadata.

Use this tool after `search` identifies a relevant document.

#### `list_datasources_and_entity_types`

List the data sources and entity types available in the current scope.

**Parameters:**

- `filters`: Optional runtime data source scope
- `thought`: Reason the agent selected the tool

**Returns:** Data source IDs and available graph entity types.

Use this tool to discover available data before building filters or graph queries.

### Graph exploration tools

These tools are available when Graph RAG is enabled (`ENABLE_GRAPH_RAG=true`).

#### `graph_explore_ontology_entity`

Explore entity type schemas and their relationships.

**Parameters:**

- `entity_type` (required): Entity type name
- `depth`: Relationship depth from `1` to `3` (default: `1`)
- `filters`: Optional runtime data source scope
- `thought`: Reason the agent selected the tool

**Returns:** Entity type schema with properties and connected relationship types.

Use this tool to understand the ontology schema and discover relationships.

#### `graph_explore_data_entity`

Explore a specific entity instance and its neighborhood.

**Parameters:**

- `entity_type` (required): Entity type name
- `primary_key_id` (required): Entity primary key
- `depth`: Relationship depth from `1` to `3` (default: `1`)
- `filters`: Optional runtime data source scope
- `thought`: Reason the agent selected the tool

**Returns:** Entity with properties and related entities.

Use this tool to investigate a specific entity and its connections.

#### `graph_fetch_data_entity_details`

Get complete properties and all relations for an entity.

**Parameters:**

- `entity_type` (required): Entity type name
- `primary_key_id` (required): Entity primary key
- `filters`: Optional runtime data source scope
- `thought` (required): Reason the agent selected the tool

**Returns:** Full entity details including all properties and relationships.

Use this tool when an agent needs complete information about one entity.

#### `graph_shortest_path_between_entity_types`

Find relationship paths between two entity types.

**Parameters:**

- `entity_type_1` (required): First entity type
- `entity_type_2` (required): Second entity type
- `filters`: Optional runtime data source scope
- `thought` (required): Reason the agent selected the tool

**Returns:** Path in Cypher notation showing relationship chain.

Use this tool to understand how entity types connect before planning a graph query.

#### `graph_raw_query_data` / `graph_raw_query_ontology`

Execute custom read-only Cypher queries.

**Parameters:**

- `query` (required): Read-only Cypher query
- `filters`: Optional runtime data source scope for `graph_raw_query_ontology`
- `thought` (required): Reason the agent selected the tool

**Returns:** Query results (limited to configured max results).

Use these tools for queries that the graph exploration tools cannot express.

**Authorization:** Data-graph exploration is restricted to data sources the caller
can search. Raw data-graph queries and deployment-wide ontology operations
require unrestricted data source access. Queries are also scoped to the relevant
graph label: `NxsDataEntity` or `NxsSchemaEntity`.

## Filtering

Search and exploration tools support metadata filters:

| Filter key | Description | Example |
|------------|-------------|---------|
| `datasource_id` | Filter by data source | `"primary"` |
| `collection_id` | Filter by collection | `"primary"` |
| `ingestor_id` | Filter by ingestor | `"primary-ingestor"` |
| `is_structured_entity` | Only structured entities | `true` |
| `document_type` | Filter by document type | `"runbook"`, `"structured:Pod"` |
| `metadata.<key>` | Filter by nested metadata | `metadata.structured_entity_type` |

For structured entities, prefix the entity type with `structured:`. For example,
use `"structured:Workload"` to return only `Workload` entities.

### Nested metadata filters

Use dot notation to filter custom fields in the `metadata` object:

```json
{
  "filters": {
    "metadata.structured_entity_type": "Workload",
    "metadata.custom_field": "value"
  }
}
```

Use nested filters for ingestor-specific metadata that is not available as a
top-level field.

Filters are combined with AND logic.

## Example agent workflow

This example shows how an agent can answer, "What workloads are running on
`node-a`?"

1. **Discover schema:**
   ```text
   list_datasources_and_entity_types()
   → Returns "Workload" and "Node" entity types from the primary data source
   ```

2. **Explore relationships:**
   ```text
   graph_explore_ontology_entity(entity_type="Workload", depth=1)
   → Returns the "RUNS_ON" relationship from Workload to Node
   ```

3. **Find the node:**
   ```text
   search(query="node-a", filters={"document_type": "structured:Node"})
   → Returns the Node primary key
   ```

4. **Explore the node's workloads:**

   ```text
   graph_explore_data_entity(entity_type="Node", primary_key_id="node-a", depth=1)
   → Returns Workloads connected to the Node
   ```

## Configuration

### Enable or disable MCP

```bash
ENABLE_MCP=true  # default
```

### Result truncation

```bash
SEARCH_RESULT_TRUNCATE_LENGTH=500  # Characters per result in search
```

### Graph query limits

```bash
MAX_GRAPH_RAW_QUERY_RESULTS=100   # Max entities per query
MAX_GRAPH_RAW_QUERY_TOKENS=80000  # Max tokens in results
```

## Further reading

- [Server architecture](https://github.com/caipe-io/ai-platform-engineering/tree/main/ai_platform_engineering/knowledge_bases/rag/server/ARCHITECTURE.md) — MCP implementation details
- [Knowledge Bases architecture](architecture.md) — system-level architecture
- [MCP specification](https://modelcontextprotocol.io/) — official MCP documentation
