# Webex Ingestor

Ingests messages from Webex spaces as documents into the RAG system. Each space becomes a datasource, and each message becomes a document. This allows the RAG system to search and retrieve relevant Webex conversations.

## Supported Features

- Incremental syncing (only fetches new messages since last sync)
- Message content and metadata extraction
- Configurable lookback period for initial sync
- Bot message filtering (optional)
- File attachment tracking
- Automatic retry and rate limit handling

## Required Environment Variables

- `WEBEX_ACCESS_TOKEN` - Webex Bot or Integration access token
- `WEBEX_BOT_NAME` - Name of your Webex bot (used mostly for ingestor identification, e.g., `mybot`)
- `WEBEX_SPACES` - JSON object mapping space IDs to configuration
- `RAG_SERVER_URL` - URL of the RAG server (default: `http://localhost:9446`)

## WEBEX_SPACES Format

```json
{
  "Y2lzY29zcGFyazovL3VzL1JPT00vYmJjZWIxYWQtNDNmMS0zYjU4LTkxNDctZjE0YmIwYzRkMTU0": {
    "name": "General Discussion",
    "lookback_days": 30,
    "include_bots": false
  },
  "Y2lzY29zcGFyazovL3VzL1JPT00vZGVmNTY3ODktMTJhYi00Y2RlLTg5MDEtMjNhYjQ1NjcxMjM0": {
    "name": "Engineering Team",
    "lookback_days": 90,
    "include_bots": true
  }
}
```

**💡 Tip:** Use the interactive configuration builder to easily create your WEBEX_SPACES configuration:

```bash
cd src/ingestors/webex
python3 build_config.py
```

This script will walk you through adding spaces and generate the properly formatted environment variable for you.

## Space Configuration Options

- `name` - Human-readable space name (used in document metadata)
- `lookback_days` - Number of days to look back on first sync (0 = all history)
- `include_bots` - Whether to include bot messages (default: `false`)
- `reload_interval` - Refresh interval for this datasource in seconds (default for legacy config: `86400`)

## Optional Environment Variables

- `INIT_DELAY_SECONDS` - Delay before first sync in seconds (default: `0`)
- `LOG_LEVEL` - Logging level (default: `INFO`)

## Setup Instructions

### 1. Create a Webex Bot or Integration

- Go to https://developer.webex.com/my-apps
- Click "Create a New App"
- Choose "Create a Bot" for automated ingestion (recommended)
- Or choose "Create an Integration" for OAuth-based access
- Fill in the required details and create the app

### 2. Get Your Access Token

- For Bots: Copy the "Bot Access Token" from your bot's page
- For Integrations: Complete the OAuth flow to get an access token
- **Important:** Personal access tokens expire after 12 hours and should only be used for testing

### 3. Add Bot to Spaces

- In each Webex space you want to ingest, add your bot as a member
- The bot must be a member of the space to read messages
- You can add the bot by mentioning it: `@YourBotName`

### 4. Get Space IDs

Use the Webex API to list your spaces:

```bash
curl -X GET https://webexapis.com/v1/rooms \
  -H "Authorization: Bearer ${WEBEX_ACCESS_TOKEN}"
```

- Copy the `id` field from each space you want to ingest
- Space IDs are long base64-encoded strings

## Running with Docker Compose

```bash
export RAG_SERVER_URL=http://host.docker.internal:9446 # Adjust based on your setup
export WEBEX_ACCESS_TOKEN=your-webex-access-token
export WEBEX_BOT_NAME=mybot
export WEBEX_SPACES='{"Y2lzY29zcGFyazovL3VzL1JPT00vYmJjZWIxYWQtNDNmMS0zYjU4LTkxNDctZjE0YmIwYzRkMTU0":{"name":"General","lookback_days":30,"include_bots":false}}'
docker compose --profile webex up --build webex_ingestor
```

## Document Structure

### For messages

- Document ID: `webex-message-{space_id}-{message_id}`
- Title: "Message: {first 100 chars of message}"
- Content: Formatted message with sender, timestamp, and content
- Metadata: space name, space ID, message ID, sender email, timestamp, file attachments

## Notes

The Webex ingestor:
- Creates one datasource per space (ID format: `webex-space-{space_id}`)
- Stores the last message timestamp in datasource metadata for incremental updates
- Each message becomes a separate document (Webex doesn't have native threading like Slack)
- Requires the bot to be a member of each space you want to ingest
- Respects Webex API rate limits with automatic retry logic
- Tracks file attachments but doesn't download file content (only metadata)
- Uses ISO 8601 timestamps for all time-based operations
