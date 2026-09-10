# Slack Ingestor

Ingests Slack conversations into RAG. Each channel is a datasource; each thread
or standalone message is a document.

## Datasource configuration

Create channels in the Web UI, or seed view-only channels through
`rag_sources` in `config/app-config.yaml` (Compose) or
`caipe-ui.appConfig.rag_sources` (Helm):

```yaml
rag_sources:
  - source_type: slack_channel
    channel_id: C1234567890
    name: team-updates
    lookback_days: 30
    include_bots: false
    search_with_teams: [primary]
    reload_interval: 86400
```

Changing or removing a seeded datasource requires changing the application
config and restarting the UI so it can reconcile the seed.

## Connector environment

Required:

- `SLACK_BOT_TOKEN`: Bot User OAuth token.
- `SLACK_BOT_NAME`: Bot name used for ingestor identification.
- `SLACK_WORKSPACE_URL`: Workspace URL.
- `RAG_SERVER_URL`: RAG server URL.

Optional:

- `INIT_DELAY_SECONDS`: Startup delay in seconds. Default: `0`.
- `LOG_LEVEL`: Logging level. Default: `INFO`.

The bot needs `channels:history` and `channels:read` for public channels,
plus `groups:history` and `groups:read` for private channels. Invite it to
every configured channel.

## Behavior

- Datasource ID: `slack-channel-{channel_id}`.
- Incremental reloads use the last message timestamp stored in datasource metadata.
- Threads are grouped into one document.
- Slack rate limits use retry with exponential backoff.
