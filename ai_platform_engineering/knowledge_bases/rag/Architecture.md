# Architecture

## Overview

The RAG (Retrieval-Augmented Generation) platform is a knowledge base system that ingests documents and structured entities, performs hybrid vector search, and automatically discovers relationships between entities using AI agents.

## Core Components

| Component | Port | Purpose |
|-----------|------|---------|
| **Server** | 9446 | REST API for ingestion, hybrid search, and graph exploration |
| **Ontology Agent** | 8098 | Automated schema discovery and relationship evaluation |
| **Ingestors** | - | External scripts that pull data from various sources |

## Component Communication

```
┌─────────────┐                                              ┌──────────────────┐
│  Ingestors  │                                              │ Ontology Agent   │
│ (web, AWS,  │            ┌──────────┐                      │ (LLM Workers)    │
│ Backstage)  │───(REST)──►│  Server  │◄────────────────────►│                  │
└─────────────┘            │ (FastAPI)│                      └──────────────────┘
 Ingest docs               │          │                               │
                           │          │                               │
┌─────────────┐            │          │                               │
│ AI Agent    │            │          │                               │
│ (MCP Tools) │───(MCP)───►│          │                               │
└─────────────┘            └──────────┘                               │
 Use tools                       │                                    │
                                 │                                    │
                                 └────────────┬───────────────────────┘
                                              │
                                              ▼
                    ┌──────────────────────────────────────────────────────────┐
                    │                      DATABASES                           │
                    │                                                          │
                    │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
                    │  │   Milvus     │  │  Neo4j Data  │  │ Neo4j Onto.  │    │
                    │  │  (Vectors)   │  │   (Graph     │  │   (Graph     │    │
                    │  │              │  │  Entities)   │  │   Schema)    │    │
                    │  └──────────────┘  └──────────────┘  └──────────────┘    │
                    │                                                          │
                    │  ┌───────────────────┐                                   │
                    │  │    Redis          │                                   │
                    │  │  (Metadata +      │                                   │
                    │  │  Graph Metrics)   │                                   │
                    │  └───────────────────┘                                   │
                    └──────────────────────────────────────────────────────────┘

* Neo4j uses tenant isolation: NxsDataEntity and NxsSchemaEntity labels
```

## Data Flow

### 1. Document Ingestion

```
External Source → Ingestor → Server API (/v1/ingest)
                                  │
                    ┌─────────────┴──────────────┐
                    ▼                            ▼
              Text Chunking                Graph Entity
              + Embeddings                 Parsing & Splitting
                    │                            │
                    ▼                            ▼
            Milvus (dual vectors:          Neo4j Data Graph
            dense + sparse BM25)           + Milvus
```

**Key Steps:**
- Ingestors fetch data from sources (AWS, K8s, Backstage, URLs, Slack, Webex)
- Documents submitted to server with metadata and job tracking
- Server chunks documents and generates dual embeddings (semantic + keyword)
- Graph entities parsed, nested structures split into sub-entities
- Dual storage: Milvus for search, Neo4j for relationships

### 2. Ontology Discovery

```
Neo4j Data Graph → Ontology Agent
                        │
                        ▼
            BM25 Fuzzy Search + Bloom Filter
            (Find candidate matches)
                        │
                        ▼
            Deep Property Matching
            (Validate candidates)
                        │
                        ▼
                Redis (Metrics)
                + Neo4j Ontology Graph
                        │
                        ▼
            Parallel LLM Evaluation
            (10 workers)
                        │
                        ▼
            Accept/Reject Relations
                        │
                        ▼
            Sync to Data Graph
```

**Key Steps:**
- Agent automatically runs every 6 hours (configurable)
- Builds BM25 index with Bloom filter pre-filtering
- Discovers candidate relationships via fuzzy property matching
- Stores metrics in Redis, structure in Neo4j ontology graph
- Distributes candidates to parallel LLM workers for evaluation
- Accepted relations synced back to data graph

### 3. Query & Search

```
User Query → Server API (/v1/query)
                   │
                   ▼
          Apply Metadata Filters
          (datasource, type)
                   │
        ┌──────────┴──────────┐
        ▼                     ▼
 Semantic Search         BM25 Search
 (dense vectors)         (sparse vectors)
        │                     │
        └──────────┬──────────┘
                   ▼
          Weighted Reranking
          (configurable weights)
                   │
                   ▼
          Results with Scores
```

**Key Features:**
- Hybrid search combines semantic (dense vectors) and keyword (BM25) matching
- Adjustable weight parameters for semantic vs. keyword balance
- Filter by datasource, entity type, document type
- Graph entity exploration from search results

### 4. Graph Visualization

```
Server API
    │
    ┌───────┴────────┐
    ▼                ▼
Ontology Graph   Data Graph
    │                │
    ▼                ▼
Entity Types     Entity Instances
+ Relations      + Neighborhoods
```

**Two Graph Views:**
- **Ontology Graph**: Entity type schemas and their relationships with evaluation status
- **Data Graph**: Actual entity instances with recursive sub-entity expansion

## Component Details

### Server (Port 9446)

**Technologies:** FastAPI, LangChain, Milvus, Neo4j, Redis

**Key Responsibilities:**
- Document processing pipeline with automatic chunking
- Dual vector embeddings (dense semantic + sparse BM25)
- Graph entity parsing with nested structure splitting
- Hybrid search with weighted reranking
- Job management and progress tracking
- MCP tools for AI agent integration

### Ontology Agent (Port 8098)

**Technologies:** LangGraph, BM25, Bloom Filters, Parallel LLM Workers

**Key Responsibilities:**
- BM25 fuzzy search with Bloom filter optimization (10M bits, 1% error rate)
- Deep property matching with quality scoring
- Parallel LLM evaluation (10 workers, isolated queues)
- Dual storage: Redis for hot metrics, Neo4j for structure
- Automatic synchronization to data graph
- Background processing with manual trigger support

### Ingestors

**Available Ingestors:**
- **AWS**: EC2, S3, RDS, Lambda, and more
- **Kubernetes**: Pods, Deployments, Services, CRDs
- **Backstage**: Service catalog entities
- **ArgoCD**: Applications, projects, clusters
- **Slack**: Channel conversations and threads
- **Webex**: Space messages
- **Web Loader**: URLs and sitemaps (built-in)

**Integration Pattern:**
- Create datasource and job via server API
- Fetch data from external source
- Submit documents/entities in batches
- Update job progress and status
- Schedule periodic sync (optional)

## Technology Stack

### Databases
- **Neo4j:** Primary graph database for data storage
- **Neo4j Ontology:** Separate instance for ontology relationships
- **Milvus:** Vector database for embeddings storage
- **Redis:** Key-value store for caching and state management

### Backend
- **Python 3.14** with UV package manager
- **FastAPI** for REST API services
- **LangChain** for LLM integration
- **LangGraph** for agent workflows

### Infrastructure
- **Docker** and **Docker Compose** for containerization
- **MinIO** for object storage
- **Etcd** for configuration management
