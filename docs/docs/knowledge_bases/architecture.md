# Knowledge Bases architecture

This page describes how CAIPE ingests, authorizes, searches, and serves
organizational knowledge. For implementation details and environment variables,
see
[RAG codebase architecture](https://github.com/caipe-io/ai-platform-engineering/tree/main/ai_platform_engineering/knowledge_bases/rag/Architecture.md).

## Component architecture

```mermaid
flowchart TB
  ENTRY["Experience and ingestion<br/>CAIPE UI · agents · MCP clients · ingestors"]
  BFF["CAIPE BFF<br/>session · capability checks"]
  RAG(["RAG server<br/>REST · MCP · ingestion · retrieval"])
  AUTH{"OIDC + OpenFGA<br/>identity · authorization"}
  ONT["Ontology Agent<br/>relationship discovery"]
  DATA[("Knowledge stores<br/>Milvus · Neo4j · Redis<br/>object storage + etcd")]

  ENTRY -->|"UI session"| BFF -->|"bearer token"| RAG
  ENTRY -->|"MCP + ingestion APIs"| RAG
  RAG <--> AUTH
  RAG <--> DATA
  ONT <--> RAG
  ONT <--> DATA

  classDef client fill:#f1f5f9,stroke:#64748b,color:#1e293b,stroke-width:2px
  classDef gateway fill:#dbeafe,stroke:#2563eb,color:#1e3a8a,stroke-width:2px
  classDef hub fill:#ede9fe,stroke:#7c3aed,color:#4c1d95,stroke-width:3px
  classDef policy fill:#fef3c7,stroke:#d97706,color:#78350f,stroke-width:2px
  classDef agent fill:#ffedd5,stroke:#ea580c,color:#7c2d12,stroke-width:2px
  classDef store fill:#ccfbf1,stroke:#0f766e,color:#134e4a,stroke-width:2px

  class ENTRY client
  class BFF gateway
  class RAG hub
  class AUTH policy
  class ONT agent
  class DATA store
```

### Core components

| Component | Default port | Responsibility |
|-----------|--------------|----------------|
| **CAIPE UI and BFF** | 3000 | Data source management, collections, search, graph exploration, and authenticated API proxying |
| **RAG server** | 9446 | Ingestion, hybrid search, graph operations, REST APIs, and MCP tools |
| **Ontology Agent** | 8098 | Optional background discovery and validation of entity relationships |
| **Ingestors** | Varies | Retrieve data from external systems and submit normalized content or entities |

OIDC establishes the caller's identity. OpenFGA relationships decide which
knowledge-base actions and resources that identity may use. The RAG server checks
data source access even when a request has already passed through the UI BFF.

## Document ingestion

```mermaid
flowchart LR
  SRC(["Document source"])
  N["1 · Normalize<br/>attach source metadata"]
  C["2 · Chunk<br/>preserve context"]
  D["3A · Embed<br/>semantic meaning"]
  S["3B · Index<br/>exact terms"]
  M[("Milvus<br/>hybrid index")]

  SRC --> N --> C
  C -->|"Dense"| D --> M
  C -->|"BM25"| S --> M

  classDef source fill:#f1f5f9,stroke:#64748b,color:#1e293b,stroke-width:2px
  classDef process fill:#dbeafe,stroke:#2563eb,color:#1e3a8a,stroke-width:2px
  classDef semantic fill:#ede9fe,stroke:#7c3aed,color:#4c1d95,stroke-width:2px
  classDef keyword fill:#fef3c7,stroke:#d97706,color:#78350f,stroke-width:2px
  classDef store fill:#ccfbf1,stroke:#0f766e,color:#134e4a,stroke-width:3px

  class SRC source
  class N,C process
  class D semantic
  class S keyword
  class M store
```

1. An ingestor retrieves source content and associates every item with a data source ID.
2. The RAG server normalizes and chunks the text while preserving useful metadata.
3. An embedding provider creates dense semantic vectors.
4. Milvus produces and indexes BM25 sparse vectors for keyword matching.
5. Milvus stores both representations for filtered hybrid retrieval.

Data source IDs are part of the security boundary. Reloading a data source
replaces its indexed content and removes stale pages while preserving its
ownership and search access.

## Structured-entity ingestion

```mermaid
flowchart LR
  SRC(["Structured source<br/>infrastructure · catalog API"])
  P["1 · Parse entities<br/>split nested structures"]
  V["2 · Build searchable<br/>representations"]
  M[("Milvus<br/>hybrid index")]
  N[("Neo4j<br/>data graph")]
  O["3 · Ontology Agent<br/>discover relationships"]
  OG[("Neo4j<br/>ontology graph")]

  SRC --> P --> V
  V -->|"Search"| M
  V -->|"Relationships"| N
  N --> O -->|"Accepted links"| OG

  classDef source fill:#f1f5f9,stroke:#64748b,color:#1e293b,stroke-width:2px
  classDef process fill:#dbeafe,stroke:#2563eb,color:#1e3a8a,stroke-width:2px
  classDef store fill:#ccfbf1,stroke:#0f766e,color:#134e4a,stroke-width:2px
  classDef agent fill:#ffedd5,stroke:#ea580c,color:#7c2d12,stroke-width:2px
  classDef ontology fill:#dcfce7,stroke:#16a34a,color:#14532d,stroke-width:3px

  class SRC source
  class P,V process
  class M,N store
  class O agent
  class OG ontology
```

Structured ingestors can submit entities and relationships instead of document
pages. The server splits nested structures into connected entities, makes their
properties searchable, and stores their relationships in Neo4j when Graph RAG
is enabled.

The Ontology Agent examines entity types and properties, finds candidate
relationships, evaluates them, and writes accepted relationships to the
ontology graph.

## Authorized query flow

```mermaid
sequenceDiagram
  autonumber
  actor Caller
  participant UI as CAIPE UI / agent runtime
  participant FGA as OpenFGA
  participant RAG as RAG server
  participant DB as Milvus / Neo4j

  Caller->>UI: Search or agent request
  Note over Caller,UI: Identity stays attached to the request
  UI->>FGA: Resolve caller capabilities and resources
  FGA-->>UI: Allowed data source IDs
  UI->>RAG: Query + bearer token + requested scope
  RAG->>FGA: Revalidate data source access
  FGA-->>RAG: Effective data source IDs
  Note over RAG,DB: Storage receives only the effective scope
  RAG->>DB: Filtered vector or graph query
  DB-->>RAG: Authorized matches
  RAG-->>Caller: Ranked results
```

For a direct search, the requested scope may include every data source the caller
can search. For an agent request, CAIPE intersects that access with the data
sources and collections selected for the agent. Both paths fail closed when
authorization cannot be verified.

## Hybrid retrieval

A query produces a dense vector and a sparse keyword representation. Milvus runs
both searches within the authorized data source filter, then CAIPE combines the
result scores with configurable weights.

| Strategy | Semantic weight | Keyword weight | Useful for |
|----------|-----------------|----------------|------------|
| Balanced | 50% | 50% | General-purpose retrieval |
| Semantic | 90% | 10% | Concepts and paraphrased language |
| Keyword | 10% | 90% | Exact identifiers and terms |

These values describe the standard presets. Deployments can tune the weights for their content and evaluation results.

## Storage and supporting services

| Service | Purpose |
|---------|---------|
| **Milvus** | Dense HNSW and sparse BM25 indexes |
| **Neo4j** | Optional data and ontology graphs |
| **Redis** | Data source metadata, ingestion jobs, and ontology state |
| **Object storage** | Milvus object persistence |
| **etcd** | Milvus metadata coordination |

## Embedding providers

The embedding factory supports provider configurations for:

- Azure OpenAI
- OpenAI
- AWS Bedrock
- Cohere
- Hugging Face
- LiteLLM
- Ollama

Use deployment-owned secrets for credentials. Do not place provider keys in reusable source configuration or documentation examples.

## Port reference

| Port | Service | Protocol |
|------|---------|----------|
| 3000 | CAIPE UI | HTTP |
| 9446 | RAG REST API and MCP server | HTTP / Streamable HTTP |
| 8098 | Ontology Agent | HTTP |
| 7687 | Neo4j | Bolt |
| 7474 | Neo4j Browser | HTTP |
| 19530 | Milvus | gRPC |
| 6379 | Redis | TCP |

Neo4j and the Ontology Agent are required only for the Graph RAG profile.

## Further reading

- [RAG server architecture](https://github.com/caipe-io/ai-platform-engineering/tree/main/ai_platform_engineering/knowledge_bases/rag/server/ARCHITECTURE.md)
- [Ontology Agent](ontology-agent.md)
- [RAG API reference](api-reference.md)
- [Authentication](authentication-overview.md)
