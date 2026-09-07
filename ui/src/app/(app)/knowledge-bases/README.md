# Knowledge Bases

RAG (Retrieval-Augmented Generation) knowledge base with SSO-based RBAC.

## Auth Flow

```
User Browser
    ↓ (authenticates via SSO)
NextAuth Session
    ↓ (makes API call)
/api/rag/* Proxy (forwards the user's Bearer token)
    ↓
RAG Server (validates the token → checks OpenFGA relationships)
    ↓
Vector DB + Graph DB
```

## Pages

### Ingest (`/knowledge-bases/ingest`)

- **Owners**: Update, reload, transfer, and delete ingestion-source configuration
- **Search members**: Query content from shared datasources
- A source has one Owner (a person or team)
- Search access is an independent list of people and teams
- Owners may administer Search grants without automatically granting a team content access
- Deep-link state:
  - `ingest=file|web|slack|confluence|jira|webex` selects the creation form
  - repeated `type`, `owner`, and `access` parameters filter visible sources
  - `q` filters datasource names and `page` selects the result page

### Search (`/knowledge-bases/search`)

- Requires the organization search capability
- Results are restricted to datasources for which the caller has Search access
- Search URLs encode `q`, `tool`, `limit`, and `filter.<key>` values so another user can rerun the same search through their own RBAC-filtered tool and datasource access

### Collections (`/knowledge-bases/collections`)

- Groups stable datasource IDs without copying chunks or changing Milvus storage
- Supports personal collections and admin-delegated collections, including the removable default `Platform RAG`
- Keeps Search, collection membership, and Owner grants independent
- Expands collection membership live for agents, so adding or removing a source propagates without editing each agent
- Uses `collection=<id>` in the URL for shareable, RBAC-filtered deep links
- Preserves datasource reload behavior: each reload replaces that datasource's indexed content and removes stale pages

### Agent and service-account RAG scope

- Direct Search/API calls use every datasource for which the caller has Search access
- Agents use direct datasource cards plus collection cards, intersected with the invoking caller's current datasource access
- Explicitly selecting no cards disables that agent's RAG tools
- Service accounts may be granted collections or individual datasources through the existing agent/tool scope editor; collection membership updates automatically
- There is no separate service-account query permission

### Graph (`/knowledge-bases/graph`)

- The data graph is restricted to datasources for which the caller has Search access
- The deployment-wide ontology requires unrestricted datasource access
- Ontology mutations require organization-admin access

### Admin settings (`/admin?category=settings&tab=rag`)

- Selects the Search Access team preselected for new sources
- Migrates already-ingested environment-configured sources into Mongo-backed management
- Governs self-service connector limits for file uploads, Slack, Confluence, Jira, Web, and Webex
- Applies connector policies on application API creates, edits, previews, retries, reloads, and file uploads
- Does not silently rewrite existing source settings; a source outside a newly tightened policy must be adjusted before its next edit or manual reload
- Keeps the RAG server's deployment-level validation as the absolute safety ceiling

Coarse token roles protect service transport boundaries. User access to sources and content is relationship-based and fails closed when the authorization service is unavailable.

## Main Components

### API Proxy (`src/app/api/rag/[...path]/route.ts`)
Server-side proxy that forwards the session's access token and applies UI-facing capability checks. The RAG server independently enforces the same authorization boundary.

### User Info Endpoint (`src/app/api/user/info/route.ts`)
Returns user's role and permissions based on SSO groups.

### API Client (`src/lib/rag-api.ts`)
Type-safe client library for all RAG operations. Automatically includes session credentials.

### IngestView (`src/components/rag/IngestView.tsx`)
Main UI for source creation, ingestion status, ownership, sharing, retry, and deletion. Server authorization remains authoritative; UI visibility is not a security boundary.

### RagCollectionsView (`src/components/rag/RagCollectionsView.tsx`)
Collection membership and delegation UI. Adding a datasource requires Owner access; adding it to a personal collection also requires Search access.

## Development

```bash
# Start RAG server
cd ai_platform_engineering/knowledge_bases/rag && docker compose up

# Configure .env.local with OIDC and OpenFGA settings

# Start UI
npm run dev

# Test: http://localhost:3000/api/user/info
```

## Troubleshooting

- **403 Forbidden**: The caller lacks the required organization capability or resource relationship.
- **401 Unauthorized**: Session expired. Re-authenticate via `/api/auth/signin`.
- **Unexpected access**: Inspect the source's Owner and Search assignments separately.
