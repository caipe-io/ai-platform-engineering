# Ingestors

Ingestors are services that pull data from external sources and submit it to the RAG server for indexing. Each ingestor connects to a specific data source, transforms the data into documents or graph entities, and manages its own sync schedule.

For implementation details and creating custom ingestors, see the [Ingestors README](https://github.com/caipe-io/ai-platform-engineering/tree/main/ai_platform_engineering/knowledge_bases/rag/ingestors/README.md).

## How Ingestors Work

All ingestors follow a common pattern:

1. **Connect** to an external data source (API, database, file system)
2. **Fetch** data with pagination and incremental sync where supported
3. **Transform** data into documents or graph entities with metadata
4. **Submit** to the RAG server via REST API (`POST /v1/ingest`)
5. **Track** job progress and handle errors
6. **Schedule** periodic syncs to keep data fresh

### Data Types

Ingestors can produce two types of data:

| Type | Storage | Use Case |
|------|---------|----------|
| **Documents** | Milvus (vectors) | Unstructured text like web pages, chat messages, wiki pages |
| **Graph Entities** | Milvus + Neo4j | Structured data with relationships like infrastructure resources |

## Available Ingestors

### Web Loader

Crawls sitemaps and web pages. Built into the RAG system and triggered via the Web UI.

| Feature | Description |
|---------|-------------|
| **Input** | Sitemap URLs or individual page URLs |
| **Output** | Documents |
| **Trigger** | On-demand via Web UI |

### AWS

Discovers and ingests AWS resources across all regions.

| Feature | Description |
|---------|-------------|
| **Input** | AWS API (via boto3) |
| **Output** | Graph Entities |
| **Entity Types** | EC2, S3, RDS, Lambda, EKS, DynamoDB, VPC, IAM, and more |
| **Documentation** | [AWS README](https://github.com/caipe-io/ai-platform-engineering/tree/main/ai_platform_engineering/knowledge_bases/rag/ingestors/src/ingestors/aws/README.md) |

### Kubernetes

Ingests Kubernetes resources including custom resources.

| Feature | Description |
|---------|-------------|
| **Input** | Kubernetes API (via kubeconfig) |
| **Output** | Graph Entities |
| **Entity Types** | Pods, Deployments, Services, ConfigMaps, Secrets, CRDs |
| **Documentation** | [Kubernetes README](https://github.com/caipe-io/ai-platform-engineering/tree/main/ai_platform_engineering/knowledge_bases/rag/ingestors/src/ingestors/k8s/README.md) |

### Backstage

Ingests entities from a Backstage service catalog.

| Feature | Description |
|---------|-------------|
| **Input** | Backstage Catalog API |
| **Output** | Graph Entities |
| **Entity Types** | Components, APIs, Systems, Domains, Groups, Users |
| **Documentation** | [Backstage README](https://github.com/caipe-io/ai-platform-engineering/tree/main/ai_platform_engineering/knowledge_bases/rag/ingestors/src/ingestors/backstage/README.md) |

### ArgoCD

Ingests GitOps resources from ArgoCD.

| Feature | Description |
|---------|-------------|
| **Input** | ArgoCD API |
| **Output** | Graph Entities |
| **Entity Types** | Applications, Projects, Clusters, Repositories, ApplicationSets |
| **Documentation** | [ArgoCD README](https://github.com/caipe-io/ai-platform-engineering/tree/main/ai_platform_engineering/knowledge_bases/rag/ingestors/src/ingestors/argocdv3/README.md) |

### GitHub

Ingests organizational data from GitHub.

| Feature | Description |
|---------|-------------|
| **Input** | GitHub API |
| **Output** | Graph Entities |
| **Entity Types** | Organizations, Repositories, Teams, Users |
| **Documentation** | [GitHub README](https://github.com/caipe-io/ai-platform-engineering/tree/main/ai_platform_engineering/knowledge_bases/rag/ingestors/src/ingestors/github/README.md) |

### Confluence

Ingests pages from Confluence spaces with incremental sync support.

| Feature | Description |
|---------|-------------|
| **Input** | Confluence REST API |
| **Output** | Documents |
| **Features** | Incremental sync, space filtering, title-based include/exclude regex patterns |
| **Documentation** | [Confluence README](https://github.com/caipe-io/ai-platform-engineering/tree/main/ai_platform_engineering/knowledge_bases/rag/ingestors/src/ingestors/confluence/README.md) |

### Slack

Ingests conversations from Slack channels.

| Feature | Description |
|---------|-------------|
| **Input** | Slack API |
| **Output** | Documents |
| **Features** | Threads grouped as single documents, channel filtering |
| **Documentation** | [Slack README](https://github.com/caipe-io/ai-platform-engineering/tree/main/ai_platform_engineering/knowledge_bases/rag/ingestors/src/ingestors/slack/README.md) |

### Webex

Ingests messages from Webex spaces.

| Feature | Description |
|---------|-------------|
| **Input** | Webex API |
| **Output** | Documents |
| **Features** | Space filtering, message threading |
| **Documentation** | [Webex README](https://github.com/caipe-io/ai-platform-engineering/tree/main/ai_platform_engineering/knowledge_bases/rag/ingestors/src/ingestors/webex/README.md) |

## Common Configuration

All ingestors share common configuration options:

| Variable | Default | Description |
|----------|---------|-------------|
| `RAG_SERVER_URL` | `http://localhost:9446` | RAG server endpoint |
| `SYNC_INTERVAL` | `86400` (24h) | Seconds between syncs |
| `INIT_DELAY_SECONDS` | `0` | Delay before first sync |
| `MAX_DOCUMENTS_PER_INGEST` | `1000` | Batch size for ingestion |
| `EXIT_AFTER_FIRST_SYNC` | `false` | Exit after one sync (for batch jobs) |

## Authentication

Ingestors authenticate with the RAG server using OAuth2 client credentials.

Ingestors obtain access tokens via OAuth2 client credentials flow:

```bash
INGESTOR_OIDC_ISSUER=https://your-keycloak.com/realms/production
INGESTOR_OIDC_CLIENT_ID=rag-ingestor
INGESTOR_OIDC_CLIENT_SECRET=xxx
```

The ingestor client automatically:
- Fetches tokens via client credentials grant
- Caches tokens and refreshes before expiry
- Includes Bearer token in all API calls

Trusted-network detection is telemetry only and does not authenticate ingestors.

## Creating Custom Ingestors

The `IngestorBuilder` class provides a simple framework for creating ingestors:

```python
from common.ingestor import IngestorBuilder

async def sync_data(client):
    # Your sync logic here
    pass

IngestorBuilder()\
    .name("my-ingestor")\
    .type("custom")\
    .sync_with_fn(sync_data)\
    .every(3600)\  # Sync every hour
    .run()
```

See the [Ingestors README](https://github.com/caipe-io/ai-platform-engineering/tree/main/ai_platform_engineering/knowledge_bases/rag/ingestors/README.md) for a complete example with job management and error handling.

## Further Reading

- [Ingestors README](https://github.com/caipe-io/ai-platform-engineering/tree/main/ai_platform_engineering/knowledge_bases/rag/ingestors/README.md) - Creating custom ingestors
- [Common Package](https://github.com/caipe-io/ai-platform-engineering/tree/main/ai_platform_engineering/knowledge_bases/rag/common/README.md) - Shared models and utilities
- [Authentication Overview](authentication-overview.md) - RBAC and security concepts
