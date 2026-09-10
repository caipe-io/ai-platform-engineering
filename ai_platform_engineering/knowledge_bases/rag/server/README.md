# RAG Server

The server component provides REST APIs for document ingestion, vector search, graph exploration, and MCP tools for AI agents.

## Quick Start

### Running with Docker Compose

The server requires several dependencies. Use the root `docker-compose.yaml` to start all services:

```bash
docker compose --profile deps up
```

### Running Locally

1. Install dependencies:
```bash
cd server
uv sync
```

2. Set environment variables (see Configuration below)

3. Start the server:
```bash
source ./.venv/bin/activate
LOG_LEVEL=DEBUG python src/server/__main__.py
```

The server will be available at `http://localhost:9446`

## Service Connections

### Required Services

| Service | Default Connection | Purpose |
|---------|-------------------|---------|
| Redis | `redis://localhost:6379` | Metadata storage and job queue |
| Milvus | `http://localhost:19530` | Vector database for hybrid search |
| Neo4j | `bolt://localhost:7687` | Graph database (optional, if Graph RAG enabled) |

### Optional Services

| Service | Default Connection | Purpose |
|---------|-------------------|---------|
| Ontology Agent | `http://localhost:8098` | Graph ontology management (if Graph RAG enabled) |

## Ports

| Port | Service | Description |
|------|---------|-------------|
| 9446 | REST API | Main API endpoints for ingestion, query, and management |
| 9446 | MCP Server | Model Context Protocol endpoints at `/mcp/*` |

## Configuration

## Configuration

### Authentication

**JWT Validation (Production):**
```bash
# OIDC configuration for UI token validation
OIDC_ISSUER=https://your-keycloak.com/realms/production
OIDC_CLIENT_ID=rag-ui

# OIDC configuration for ingestor token validation
INGESTOR_OIDC_ISSUER=https://your-keycloak.com/realms/production
INGESTOR_OIDC_CLIENT_ID=rag-ingestor
```

**JWT Identity plus OpenFGA Authorization:**

The RAG server validates the access token and uses it as identity input for OpenFGA. This is the standards-compliant approach where:
- Only the access token is sent to the RAG server
- `sub` becomes the OpenFGA subject (`user:<sub>`)
- Email is extracted for display and audit context
- Human RAG permissions come from OpenFGA relationships

The server will:
1. Validate the **access token** for authentication (signature, expiry, audience, issuer)
2. Extract the user's `sub` (subject) from the access token
3. Extract display email from token claims
4. Check OpenFGA for KB/datasource read, ingest, and manage relationships

This approach:
- Eliminates the need for ID tokens to be passed downstream
- Keeps Keycloak focused on identity
- Makes OpenFGA the source of truth for RAG authorization
- Is the OAuth 2.0 recommended pattern for resource servers

**RBAC (Service Role Assignment):**
```bash
# Default role for client-credentials tokens
RBAC_CLIENT_CREDENTIALS_ROLE=ingestonly
```

**Role Permissions:**
- `readonly`: Authenticated human baseline; KB access still requires OpenFGA
- `ingestonly`: Service clients that ingest data and manage jobs
- `admin`: Administrative service clients

### Authentication Methods & Role Assignment

This table shows how different authentication methods map to roles and which environment variables control them:

| Auth Method | Actor Type | Default Role | Role Controlled By | Required Env Vars | Optional Env Vars |
|-------------|------------|--------------|-------------------|-------------------|-------------------|
| **OAuth2 (UI)** | User | `readonly` baseline | OpenFGA relationships | `OIDC_ISSUER`<br>`OIDC_CLIENT_ID`<br>`OPENFGA_HTTP` | `OIDC_DISCOVERY_URL` |
| **OAuth2 (Ingestor)** | Ingestor | `ingestonly` | `RBAC_CLIENT_CREDENTIALS_ROLE` | `INGESTOR_OIDC_ISSUER` or `INGESTOR_OIDC_DISCOVERY_URL`<br>`INGESTOR_OIDC_CLIENT_ID` | `INGESTOR_OIDC_SCOPE` |

**Key Points:**

1. **OAuth2 for UI (User Tokens)**
   - Regular user authentication with JWT access tokens
   - Token `sub` is used as the OpenFGA subject (`user:<sub>`)
   - KB access is checked through OpenFGA `knowledge_base:<id>#can_*` relationships

2. **OAuth2 for Ingestors (Client Credentials)**
   - Machine-to-machine authentication using client credentials flow
   - No user context (uses `client_id` instead of email)
   - Role controlled by `RBAC_CLIENT_CREDENTIALS_ROLE` (default: `ingestonly`)
   - Token validated against `INGESTOR_OIDC_ISSUER` or `INGESTOR_OIDC_DISCOVERY_URL`
   - Can send `X-Ingestor-Type` and `X-Ingestor-Name` headers for better logging

### Core Connection Settings

```bash
# Redis
REDIS_URL=redis://localhost:6379

# Milvus Vector Database
MILVUS_URI=http://localhost:19530

# Neo4j Graph Database (if Graph RAG enabled)
NEO4J_ADDR=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=your-password
```

### Feature Flags

```bash
# Enable/disable graph RAG features
ENABLE_GRAPH_RAG=true

# Enable/disable MCP tools for AI agents
ENABLE_MCP=true

# Enable/disable MCP authentication (requires OIDC configuration)
MCP_AUTH_ENABLED=true

# Skip connection tests on startup (useful for debugging)
SKIP_INIT_TESTS=false
```

### Embeddings Configuration

The server supports multiple embedding providers. Most are API-based and work with the default image.

**Supported Providers:**

| Provider | Image Required | Environment Variables |
|----------|---------------|----------------------|
| `azure-openai` (default) | Default | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_VERSION` |
| `openai` | Default | `OPENAI_API_KEY` |
| `aws-bedrock` | Default | AWS credentials via boto3 |
| `cohere` | Default | `COHERE_API_KEY` |
| `ollama` | Default | `OLLAMA_BASE_URL` |
| `litellm` | Default | `LITELLM_API_BASE`, `LITELLM_API_KEY` |
| `huggingface` | **`-hf` variant** | `HUGGINGFACEHUB_API_TOKEN` (optional), `EMBEDDINGS_DEVICE` |

```bash
# Embeddings provider
EMBEDDINGS_PROVIDER=azure-openai

# Model name
EMBEDDINGS_MODEL=text-embedding-3-small

# Azure OpenAI (if using azure-openai provider)
AZURE_OPENAI_API_KEY=your-api-key
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
AZURE_OPENAI_API_VERSION=2024-02-15-preview

# OpenAI (if using openai provider)
OPENAI_API_KEY=your-api-key

# HuggingFace (requires -hf image variant)
# EMBEDDINGS_PROVIDER=huggingface
# EMBEDDINGS_MODEL=sentence-transformers/all-MiniLM-L6-v2
# EMBEDDINGS_DEVICE=cpu  # or cuda, mps
# EMBEDDINGS_BATCH_SIZE=32
```

> **Note:** Using `EMBEDDINGS_PROVIDER=huggingface` with the default image will result in an error prompting you to use the `-hf` image variant.

### Performance & Limits

```bash
# Max documents per ingestion request
MAX_DOCUMENTS_PER_INGEST=1000

# Max results per query
MAX_RESULTS_PER_QUERY=100

# Max concurrent tasks during ingestion
MAX_INGESTION_CONCURRENCY=30

# Max results for raw graph queries
MAX_GRAPH_RAW_QUERY_RESULTS=100

# Max tokens in raw query results before truncation
MAX_GRAPH_RAW_QUERY_TOKENS=80000

# Truncate search results to N characters (for MCP tools)
SEARCH_RESULT_TRUNCATE_LENGTH=500
```

### Other Settings

```bash
# Logging level (DEBUG, INFO, WARNING, ERROR)
LOG_LEVEL=INFO

# WebUI URL (for health check response)
UI_URL=http://localhost:9447

# Ontology agent service URL (if Graph RAG enabled)
ONTOLOGY_AGENT_RESTAPI_ADDR=http://localhost:8098

# Sleep duration (seconds) on init failure before shutdown
SLEEP_ON_INIT_FAILURE_SECONDS=180

# Cleanup interval (seconds) for stale data
CLEANUP_INTERVAL=10800
```

## Milvus Collection Configuration

The server creates a collection named `rag_default` with:

**Dense Vector Index (Semantic Search):**
- Type: HNSW (Hierarchical Navigable Small World)
- Metric: Cosine similarity
- Dimension: Based on embeddings model

**Sparse Vector Index (Keyword Search):**
- Type: Sparse Inverted Index
- Metric: BM25
- Auto-generated from text content

**Dynamic Fields:** Enabled for flexible metadata storage

## Neo4j Configuration

When Graph RAG is enabled, the server uses **tenant labels** to isolate data in shared Neo4j instances:

- **Data Graph**: `NxsDataEntity` - Stores entity instances
- **Ontology Graph**: `NxsSchemaEntity` - Stores entity schemas


## Health Check

Check server health and configuration:

```bash
curl http://localhost:9446/healthz
```

Response includes:
- Service initialization status
- Database connections
- Enabled features
- Available datasources
- Configuration details

## API Documentation

Once the server is running, view interactive API docs:

- **Swagger UI**: http://localhost:9446/docs
- **ReDoc**: http://localhost:9446/redoc

## MCP Tools

The server exposes MCP (Model Context Protocol) tools for AI agents at `/mcp/*` endpoints.

For detailed architecture and tool descriptions, see [ARCHITECTURE.md](./ARCHITECTURE.md).

## Deployment

### Docker

The server is available in two image variants:

| Variant | Tag | Size | Use Case |
|---------|-----|------|----------|
| **Default (slim)** | `:latest`, `:0.2.x` | ~1.3 GB | API-based embeddings (Azure OpenAI, OpenAI, Bedrock, Cohere, LiteLLM, Ollama) |
| **HuggingFace** | `:latest-hf`, `:0.2.x-hf` | ~2.3 GB | Local HuggingFace/sentence-transformers models (includes PyTorch) |

**Pull the default image:**
```bash
docker pull ghcr.io/caipe-io/caipe-rag-server:latest
```

**Pull the HuggingFace variant (if using local embeddings):**
```bash
docker pull ghcr.io/caipe-io/caipe-rag-server:latest-hf
```

Build the server image locally:

```bash
# Default (slim) variant
docker build -f build/Dockerfile.server -t rag-server .

# HuggingFace variant (includes PyTorch)
docker build -f build/Dockerfile.server --build-arg VARIANT=huggingface -t rag-server:hf .
```

Run with environment variables:

```bash
docker run -d \
  -p 9446:9446 \
  -e REDIS_URL=redis://redis:6379 \
  -e MILVUS_URI=http://milvus:19530 \
  -e NEO4J_ADDR=bolt://neo4j:7687 \
  -e AZURE_OPENAI_API_KEY=${AZURE_OPENAI_API_KEY} \
  -e AZURE_OPENAI_ENDPOINT=${AZURE_OPENAI_ENDPOINT} \
  rag-server
```

## Helm Chart Configuration

The RAG server Helm chart exposes RBAC configuration in `values.yaml`:

```yaml
# charts/rag-stack/charts/rag-server/values.yaml
rbac:
  allowUnauthenticated: false       # Require authentication
  adminGroups: "admin"
  ingestonlyGroups: "rag-access"
  readonlyGroups: "rag-readonly"
  defaultRole: "readonly"
```

For settings not yet in the Helm chart, use the `env` section:

```yaml
# values-production.yaml
env:
  CAIPE_UNSAFE_RBAC_BYPASS: "false"
```

Deploy with custom values:

```bash
helm upgrade rag-server charts/rag-stack/charts/rag-server \
  -f values-production.yaml \
  --set image.tag=latest
```

## Troubleshooting

### Authentication Issues

#### "Unauthenticated" despite valid JWT

**Symptom:** Server returns `is_authenticated: false` even with valid token

**Diagnosis:**
```bash
# Check if JWT is expired
docker logs rag_server | grep "Signature has expired"

# Check what's in the JWT token
docker logs rag_server | grep "Token claims keys:"
```

**Solution:**
- If "Signature has expired": Token expired, implement refresh or use access token
- If missing claims: Configure correct claim mappings (`OIDC_EMAIL_CLAIM`, etc.)

#### "readonly" role instead of expected role

**Symptom:** Human user info shows `readonly`.

**Cause:** `readonly` is the authenticated identity baseline for human users.
It does not grant KB access by itself.

**Solution:**
- Grant the user or their CAIPE team the required OpenFGA relationship on the
  target `knowledge_base`, `data_source`, or `mcp_tool`.
- Do not use static AD/OIDC group variables for RAG authorization; they are not
  consumed by the RAG server.

#### "Invalid email format" warning

**Symptom:** Log shows `Invalid email format in token claims: c8d1d12e1d9d471e...`

**Cause:** Server is reading the `sub` claim instead of `email`/`username`

**Solution:** Configure correct email claim:
```bash
OIDC_EMAIL_CLAIM=email     # Standard OIDC
# or
OIDC_EMAIL_CLAIM=username  # If provider uses username claim
```

### Performance Issues

#### Slow ingestion

- Increase `MAX_INGESTION_CONCURRENCY` (default: 30)
- Check Milvus resource allocation
- Monitor Neo4j memory usage (if Graph RAG enabled)

#### Query timeouts

- Increase Milvus query timeout
- Reduce `MAX_RESULTS_PER_QUERY` for faster responses
- Use more specific filters to narrow search scope

#### Out of memory

- Reduce `MAX_DOCUMENTS_PER_INGEST` for smaller batches
- Decrease `MAX_INGESTION_CONCURRENCY`
- Allocate more memory to Milvus and Neo4j containers

## Development

### Running tests

```bash
cd server
uv run pytest
```

### Adding new endpoints

1. Add endpoint to `restapi.py`
2. Update models in `common/src/common/models/`
3. Add tests in `tests/`
4. Update API documentation

### Adding new MCP tools

1. Add tool method to `AgentTools` class in `tools.py`
2. Register tool in `register_tools()` method
3. Add documentation in `ARCHITECTURE.md`

## See Also

- [ARCHITECTURE.md](./ARCHITECTURE.md) - Detailed architecture documentation
- [Common Models](../common/README.md) - Shared data models
- [Ingestors](../ingestors/README.md) - Building custom ingestors
