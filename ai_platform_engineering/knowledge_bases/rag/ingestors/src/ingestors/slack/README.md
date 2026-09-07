# Slack Ingestor

Ingests conversations from Slack channels as documents into the RAG system. Each channel becomes a datasource, and each thread (or standalone message) becomes a document. This allows the RAG system to search and retrieve relevant Slack conversations.

## Supported Features

- Incremental syncing (only fetches new messages since last sync)
- Thread support (messages with replies are grouped as single documents)
- Standalone message support (messages without threads)
- Configurable lookback period for initial sync
- Bot message filtering (optional)
- Slack message URLs for easy navigation back to source

## Required Environment Variables

- `SLACK_BOT_TOKEN` - Slack Bot User OAuth Token (starts with `xoxb-`)
- `SLACK_BOT_NAME` - Name of your Slack bot (used for ingestor identification, e.g., `mybot`)
- `SLACK_WORKSPACE_URL` - Your Slack workspace URL (e.g., `https://mycompany.slack.com`)
- `SLACK_CHANNELS` - JSON object mapping channel IDs to configuration
- `RAG_SERVER_URL` - URL of the RAG server (default: `http://localhost:9446`)

## SLACK_CHANNELS Format

```json
{
  "C1234567890": {
    "name": "general",
    "lookback_days": 30,
    "include_bots": false
  },
  "C0987654321": {
    "name": "engineering",
    "lookback_days": 90,
    "include_bots": true
  }
}
```

**💡 Tip:** Use the interactive configuration builder to easily create your SLACK_CHANNELS configuration:

```bash
cd src/ingestors/slack
python3 build_config.py
```

This script will walk you through adding channels and generate the properly formatted environment variable for you.

## Channel Configuration Options

- `name` - Human-readable channel name (used in document metadata)
- `lookback_days` - Number of days to look back on first sync (0 = all history)
- `include_bots` - Whether to include bot messages (default: `false`)
- `reload_interval` - Refresh interval for this datasource in seconds (default for legacy config: `86400`)

## Optional Environment Variables

- `INIT_DELAY_SECONDS` - Delay before first sync in seconds (default: `0`)
- `LOG_LEVEL` - Logging level (default: `INFO`)

## Setup Instructions

### 1. Create a Slack App

- Go to https://api.slack.com/apps
- Click "Create New App" → "From scratch"
- Name your app and select your workspace

### 2. Configure OAuth & Permissions

- Navigate to "OAuth & Permissions"
- Add the following Bot Token Scopes:
  - `channels:history` - View messages in public channels
  - `channels:read` - View basic channel information
  - `groups:history` - View messages in private channels (if needed)
  - `groups:read` - View basic private channel information (if needed)
- Install the app to your workspace
- Copy the "Bot User OAuth Token" (starts with `xoxb-`)

### 3. Invite Bot to Channels

- In each channel you want to ingest, type: `/invite @YourBotName`
- The bot must be a member of the channel to read messages

### 4. Get Channel IDs

- Right-click on channel name → "View channel details"
- Scroll down to find the Channel ID
- Or use Slack API (requires Admin/Oversight API access): `https://slack.com/api/conversations.list?token=YOUR_TOKEN`

## Running with Docker Compose

```bash
export RAG_SERVER_URL=http://host.docker.internal:9446 # Adjust based on your setup
export SLACK_BOT_TOKEN=xoxb-your-bot-token
export SLACK_BOT_NAME=mybot
export SLACK_WORKSPACE_URL=https://yourworkspace.slack.com
export SLACK_CHANNELS='{"C09TFMCA8HY":{"name":"general","lookback_days":30,"include_bots":false}}'
docker compose --profile slack up --build slack_ingestor
```

## Document Structure

### For threaded conversations

- Document ID: `slack-thread-{channel_id}-{thread_ts}`
- Title: "Thread: {first 100 chars of parent message}"
- Content: Formatted thread with all replies, timestamps, and Slack URLs
- Metadata: channel name, channel ID, thread timestamp, message count

### For standalone messages

- Document ID: `slack-message-{channel_id}-{ts}`
- Title: "Message: {first 100 chars of message}"
- Content: Formatted message with timestamp and Slack URL
- Metadata: channel name, channel ID, timestamp

## Notes

The Slack ingestor:
- Creates one datasource per channel (ID format: `slack-channel-{channel_id}`)
- Stores the last sync timestamp in datasource metadata for incremental updates
- Uses the workspace URL in the ingestor name for easy identification
- Automatically groups messages into threads when possible
- Requires the bot to be a member of each channel you want to ingest
- Respects Slack rate limits with automatic retry and exponential backoff
