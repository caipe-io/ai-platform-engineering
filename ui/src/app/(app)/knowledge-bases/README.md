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

- A collection is a saved search-time filter over stable datasource IDs -
  never an access grant. It does not copy chunks or change Milvus storage,
  and adding a source to one never extends who can read that source's
  content.
- Supports personal collections and admin-delegated collections. No
  collection is special-cased or auto-created.
- Adding a datasource to a collection requires Search access to it, not
  Owner/management access - since membership grants no one new access,
  that can never be used to escalate someone else's access.
- Keeps Search, collection membership, and Owner grants independent
- Expands collection membership live for agents, so adding or removing a
  source updates the agent's configured *scope* without editing each agent -
  this only narrows which sources an agent may search, never who can read them
- Uses `collection=<id>` in the URL for shareable, RBAC-filtered deep links
- Preserves datasource reload behavior: each reload replaces that datasource's indexed content and removes stale pages

### Agent and service-account RAG scope

- Direct Search/API calls use every datasource for which the caller has Search access
- Agents use direct datasource cards plus collection cards, intersected with the invoking caller's current datasource access
- Leaving both cards empty (unset, not an explicit `[]`) is the default for a
  new agent: unrestricted, searching whatever the calling user can already
  access. Explicitly clearing a previously-set restriction back to unset
  works the same way. An explicit empty selection is a deliberate opt-out
  that disables that part of the agent's RAG tools.
- Service accounts may be granted collections or individual datasources
  through the existing agent/tool scope editor. A collection scope grant
  mirrors the same semantics: it lets the service account use the collection
  as a filter, but grants no access to its member datasources - grant
  datasources directly for content access.
- There is no separate service-account query permission

### Graph (`/knowledge-bases/graph`)

- The data graph is restricted to datasources for which the caller has Search access
- The deployment-wide ontology requires unrestricted datasource access
- Ontology mutations require organization-admin access

### Admin settings (`/admin?category=settings&tab=rag`)

- Selects the Search Access team preselected for new sources
- Adopts already-ingested environment-configured sources into Mongo-backed
  management, setting a real Owner and, optionally, Search Access directly
  on each source (never inherited from a collection)
- Superadmins can bulk-apply an Owner and/or Search Access (replace or
  additive) to every datasource currently in a chosen collection - a
  remediation tool for datasources that used to be searchable only through
  collection membership, bypassing publication approval
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
