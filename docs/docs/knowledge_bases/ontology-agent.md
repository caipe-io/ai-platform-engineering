# Ontology Agent

The Ontology Agent automatically discovers and validates relationships between entity types in the knowledge graph. Instead of manually defining schemas, the agent uses fuzzy matching and LLM evaluation to identify meaningful relationships.

For configuration, implementation details, and the full architecture, see the [Ontology Agent README](https://github.com/caipe-io/ai-platform-engineering/tree/main/ai_platform_engineering/knowledge_bases/rag/agent_ontology/README.md).

## Why Automatic Ontology Discovery?

When ingesting data from multiple sources (AWS, Kubernetes, Backstage, etc.), entities naturally have relationships:

- A **Pod** runs on a **Node**
- A **Deployment** manages **ReplicaSets**
- An **EC2 Instance** belongs to a **VPC**
- A **Backstage Component** depends on other **Components**

Manually defining these relationships doesn't scale. The Ontology Agent:

- **Discovers relationships automatically** by analyzing property patterns
- **Validates with LLMs** to ensure semantic correctness
- **Adapts to new data** as entity types evolve
- **Runs continuously** in the background

## How It Works

The agent uses a multi-stage pipeline to discover relationships:

### 1. Candidate Discovery

The agent builds an in-memory search index of all entity types and their identity properties. Using BM25 fuzzy search, it finds potential matches between entity properties.

**Example:** A `Pod` has a `spec.nodeName` property. The agent searches for entities where identity keys match "node" patterns and finds `Node` entities.

**Optimization:** A Bloom filter pre-filters searches, eliminating 80-90% of non-matching queries before the BM25 search runs.

### 2. Deep Property Matching

For each candidate relationship, the agent validates the match by comparing properties in detail:

| Match Type | Quality Score | Example |
|------------|---------------|---------|
| Exact | 1.0 | `"web"` matches `"web"` |
| Prefix | 0.8 | `"web-pod"` matches `"web"` |
| Suffix | 0.7 | `"my-web"` matches `"web"` |
| Contains | 0.85 | Array contains value |

The agent computes a quality score combining BM25 relevance, match quality, and uniqueness.

### 3. LLM Evaluation

Candidates that meet quality thresholds are sent to parallel LLM workers for evaluation. Each worker:

- Reviews example entity pairs
- Examines property mappings
- Considers semantic meaning
- Decides: **Accept**, **Reject**, or **Unsure**

**Accept:** The relationship is valid. The agent assigns a semantic name (e.g., `RUNS_ON`, `MANAGES`, `BELONGS_TO`).

**Reject:** The relationship is invalid despite matching properties (e.g., coincidental name overlap).

**Unsure:** Insufficient evidence. The relationship is revisited when more data is available.

### 4. Synchronization

Accepted relationships are synced back to the data graph:

- Relationship edges created between matching entities
- Property mapping rules stored for future matching
- Sync status tracked for monitoring

### Diagram: Ontology Discovery Flow

<!-- DIAGRAM NEEDED: ontology-discovery-flow.svg

Description: Pipeline diagram showing the ontology discovery process:

Flow (top to bottom or left to right):
1. "Data Graph (Neo4j)" box with entity icons →
2. "BM25 Index + Bloom Filter" box →
3. "Candidate Discovery" box (with note: "fuzzy property matching") →
4. "Deep Property Matching" box (with note: "quality scoring") →
5. "LLM Evaluation" box with multiple worker icons (show 3 parallel workers) →
6. Decision diamond: "Accept / Reject / Unsure"
7. Accept path → "Sync to Data Graph"
8. Reject path → "Discard"
9. Unsure path → "Queue for re-evaluation"

Side elements:
- "Redis" cylinder connected to steps 2-4 (metrics storage)
- "Neo4j Ontology" cylinder connected to step 5-7 (evaluation results)

Style: Vertical pipeline with clear stage separation, parallel worker visualization
-->

## Automatic vs. Manual Trigger

### Automatic Mode

The agent runs on a timer (default: every 6 hours):

1. Discovers new relationship candidates
2. Re-evaluates candidates where data has changed significantly
3. Syncs accepted relationships to the data graph

### Manual Trigger

Trigger processing via API:

```bash
# Trigger full processing cycle
curl -X POST http://localhost:8098/v1/graph/ontology/agent/regenerate_ontology

# Check agent status
curl http://localhost:8098/v1/graph/ontology/agent/status
```

## When Relationships Are Re-evaluated

The agent tracks metrics for each relationship candidate. Re-evaluation triggers when:

- **Count changes significantly** (default: 10% change in match count)
- **Quality score changes** (new properties or improved matching)
- **Manual trigger** via API

This ensures the ontology stays current without unnecessary LLM calls.

## Storage Architecture

The agent uses dual storage for optimal performance:

| Storage | Purpose | Data Stored |
|---------|---------|-------------|
| **Redis** | Hot metrics | Match counts, quality scores, recent examples |
| **Neo4j** | Structure | Entity schemas, evaluation results, relationships |

Redis handles frequent updates during candidate discovery, while Neo4j stores the permanent schema structure and evaluation history.

## Versioning

Each processing run creates a new version (UUID). This enables:

- Safe comparison between versions
- Rollback if needed
- Gradual schema evolution
- Cleanup of old data

## Further Reading

- [Ontology Agent README](https://github.com/caipe-io/ai-platform-engineering/tree/main/ai_platform_engineering/knowledge_bases/rag/agent_ontology/README.md) - Configuration and architecture details
- [Architecture Overview](architecture.md) - System-level architecture
