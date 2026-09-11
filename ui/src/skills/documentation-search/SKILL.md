---
name: documentation-search
description: Search the internal knowledge base for runbooks, architecture documentation, ADRs, best practices, and troubleshooting guides using RAG. Use when looking for internal documentation, deployment procedures, architecture decisions, or operational runbooks.
---

# Documentation Search

Search the internal knowledge base using RAG (Retrieval-Augmented Generation) to find relevant runbooks, architecture docs, ADRs, and best practices.

## Instructions

### Phase 1: Query Understanding
1. **Parse the user's intent**:
   - Are they looking for a specific document (e.g., "deployment runbook")?
   - Are they asking a question the docs can answer (e.g., "how do we handle rollbacks?")?
   - Are they exploring a topic (e.g., "what do we know about MCP tools?")?
2. **Formulate search queries**:
   - Extract key terms from the user's question
   - Generate 2-3 variant queries to improve recall
   - Include relevant synonyms (e.g., "deploy" = "release" = "ship")

### Phase 2: Knowledge Base Search (RAG Agent)
1. **Search across document sources**:
   - Architecture Decision Records (ADRs) in `docs/docs/changes/`
   - Spec Kit documents in `.specify/specs/`
   - Runbooks and operational guides
   - README files and inline documentation
   - Confluence pages (if Confluence agent available)
   - Backstage TechDocs (if Backstage agent available)
2. **Rank results** by relevance:
   - Exact keyword matches ranked highest
   - Semantic similarity for conceptual matches
   - Recency as a tiebreaker (newer docs preferred)

### Phase 3: Answer Synthesis
1. **Direct answer**: If the docs contain a clear answer, provide it directly
2. **Compiled answer**: If information is spread across multiple docs, synthesize
3. **Source attribution**: Always cite which document(s) the answer came from
4. **Gaps identified**: Note if the question is only partially answered

## Output Format

```markdown
## Documentation Search Results

**Query**: "How do we handle database migrations?"

### Answer
Based on the internal documentation, database migrations follow this process:

1. Create a migration script using Alembic (see Runbook RB-023)
2. Test in staging environment first (required per ADR-008)
3. Run during the maintenance window defined in the on-call calendar
4. Verify with rollback script before marking complete

### Sources
| Document | Type | Relevance | Last Updated |
|----------|------|-----------|--------------|
| RB-023: Database Migration Runbook | Runbook | High | 2026-01-15 |
| ADR-008: Database Schema Changes | ADR | Medium | 2025-11-20 |
| .specify/specs/db-migration-v2.md | Spec | Medium | 2026-02-01 |

### Key Excerpts
> From **RB-023**: "Always run `alembic upgrade head --sql` first to preview
> the migration SQL before applying. Never run migrations during peak hours."

> From **ADR-008**: "We chose Alembic over Django migrations because our
> services are not Django-based and Alembic provides better raw SQL support."

### Related Topics
- Rollback procedures (see RB-024)
- Schema versioning strategy (see ADR-008)
- Testing database changes (see .specify/specs/db-testing.md)
```

## Examples

- "Search our knowledge base for deployment best practices"
- "How do we handle rollbacks?"
- "Find the runbook for EKS cluster upgrades"
- "What ADRs do we have about streaming?"
- "Show me the architecture documentation for the multi-agent system"
- "What's our convention for Helm chart versioning?"

## Guidelines

- Always cite sources - never present information without attribution
- If no relevant documents are found, say so clearly and suggest:
  - Creating the missing documentation
  - Which team might have the tribal knowledge
  - Alternative search terms to try
- Prefer internal documentation over general knowledge when both exist
- For runbooks, include the full procedure steps rather than just linking
- For ADRs, include the decision context and alternatives considered
- Flag outdated documentation (>6 months old) with a freshness warning
- If Confluence or Backstage agents are available, search those sources too
- Distinguish between authoritative docs (ADRs, runbooks) and informal docs (notes, comments)
