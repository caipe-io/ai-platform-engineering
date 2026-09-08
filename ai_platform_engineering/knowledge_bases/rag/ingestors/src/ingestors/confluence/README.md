# Confluence Ingestor

Ingests page trees from Confluence into RAG. Each datasource is rooted at one
page and can optionally include its descendants.

## Datasource configuration

Create page trees in the Web UI, or seed view-only page trees through
`rag_sources` in `config/app-config.yaml` (Compose) or
`caipe-ui.appConfig.rag_sources` (Helm):

```yaml
rag_sources:
  - source_type: confluence_space
    space_key: DOC
    start_page_url: https://confluence.example.com/wiki/spaces/DOC/pages/123/Overview
    name: documentation
    search_with_teams: [primary]
    get_child_pages: true
    allowed_title_patterns:
      - Guide.*
    denied_title_patterns:
      - Archive.*
    reload_interval: 86400
```

The URL determines the Confluence base URL and root page ID. The declared
`space_key` must match the URL. Changing or removing a seeded datasource
requires changing the application config and restarting the UI so it can
reconcile the seed.

## Connector environment

Required:

- `CONFLUENCE_URL`: Confluence base URL.
- `CONFLUENCE_USERNAME`: Connector username or email.
- `CONFLUENCE_TOKEN`: API token. `CONFLUENCE_API_TOKEN` is also accepted.
- `RAG_SERVER_URL`: RAG server URL.
- `REDIS_URL`: Redis URL. Default: `redis://localhost:6379`.

Optional:

- `CONFLUENCE_SSL_VERIFY`: Verify TLS certificates. Default: `true`.
- `CONFLUENCE_MAX_CONCURRENCY`: Concurrent page fetches. Default: `5`.
- `CONFLUENCE_MAX_INGESTION_TASKS`: Concurrent queued jobs. Default: `5`.

## Behavior

- Datasource ID includes the normalized base URL, space key, and root page ID.
- Allowed and denied title patterns are case-insensitive regular expressions.
- HTML content is converted to text and chunked before ingestion.
- Reloads use the page tree and filters persisted with the datasource.
- Job status records page fetch and ingestion failures.
