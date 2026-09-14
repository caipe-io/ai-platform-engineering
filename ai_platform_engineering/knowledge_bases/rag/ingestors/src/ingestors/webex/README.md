# Webex Ingestor

Ingests Webex messages into RAG. Each space is a datasource; each message is a
document.

## Datasource configuration

Create spaces in the Web UI, or seed view-only spaces through `rag_sources`
in `config/app-config.yaml` (Compose) or
`caipe-ui.appConfig.rag_sources` (Helm):

```yaml
rag_sources:
  - source_type: webex_space
    space_id: example-space-id
    name: team-space
    include_bots: false
    search_with_teams: [primary]
    reload_interval: 86400
```

Changing or removing a seeded datasource requires changing the application
config and restarting the UI so it can reconcile the seed.

## Connector environment

Required:

- `WEBEX_ACCESS_TOKEN`: Bot or integration access token.
- `WEBEX_BOT_NAME`: Bot name used for ingestor identification.
- `RAG_SERVER_URL`: RAG server URL.

Optional:

- `INIT_DELAY_SECONDS`: Startup delay in seconds. Default: `0`.
- `LOG_LEVEL`: Logging level. Default: `INFO`.

The bot must be a member of every configured space. Personal access tokens
expire and are suitable only for testing.

## Behavior

- Datasource ID: `webex-space-{space_id}`.
- Incremental reloads use the last message timestamp stored in datasource metadata.
- File attachments are represented by metadata; their content is not downloaded.
- API rate limits use automatic retry.
