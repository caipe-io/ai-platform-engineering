# Jira Ingestor

Ingests issues from Jira Cloud projects as documents into the RAG system. Each project key maps to one or more datasource configs, allowing multiple JQL queries per project with independent settings. Each issue becomes a document containing the full ticket context: description, linked issues (action items), custom fields (e.g. service), and comments.

## Supported Features

- JQL-based filtering — ingest any set of issues expressible as a JQL query
- ADF (Atlassian Document Format) rendering — description and comment fields are converted to plain text
- Custom field extraction — map arbitrary Jira custom field IDs to friendly names included in document content
- Linked issue support — outward/inward links are included so action item tickets appear in the document
- Comment ingestion — all issue comments are included (configurable)
- Incremental-friendly — use `updated >= -Nd` in your JQL to keep syncs fast after initial load

## Required Environment Variables

| Variable | Description |
|---|---|
| `JIRA_URL` | Jira Cloud base URL, e.g. `https://your-org.atlassian.net` |
| `JIRA_EMAIL` | Email of the service account used for API access |
| `ATLASSIAN_TOKEN` | Atlassian API token for the service account |
| `JIRA_PROJECTS` | JSON object mapping project keys to config (see below) |
| `RAG_SERVER_URL` | URL of the RAG server (default: `http://localhost:9446`) |

## JIRA_PROJECTS Format

Each project key maps to a **list** of datasource configs. A single dict is also accepted for convenience and is normalised to a one-element list.

```json
{
  "FE": [
    {
      "name": "Frontend",
      "jql": "project = FE AND issuetype = 'frontend' ORDER BY updated DESC",
      "custom_fields": {"severity": "customfield_10202"},
      "include_comments": true,
      "include_links": true
    }
  ],
  "OPS": [
    {
      "name": "untriaged",
      "jql": "project = OPS AND status = Open ORDER BY updated DESC"
    },
    {
      "name": "all-issues",
      "jql": "project = OPS AND updated >= -365d ORDER BY updated DESC",
      "include_comments": false
    }
  ]
}
```

### Per-datasource config fields

| Field | Required | Default | Description |
|---|---|---|---|
| `jql` | **yes** | | JQL query string |
| `name` | no | project key | Friendly name (used in datasource ID and logs) |
| `custom_fields` | no | `{}` | Map of friendly name to Jira field ID (e.g. `{"severity": "customfield_10202"}`) |
| `include_comments` | no | `true` | Include issue comments in document content |
| `include_links` | no | `true` | Include linked issues in document content |
| `reload_interval` | no | `86400` | Refresh interval for this datasource in seconds |

To find custom field IDs, browse to:
`https://your-org.atlassian.net/rest/api/3/field`

## Optional Environment Variables

| Variable | Default | Description |
|---|---|---|
| `JIRA_PAGE_SIZE` | `100` | Number of issues per API request (max 100) |
| `INIT_DELAY_SECONDS` | `0` | Delay before first sync in seconds |
| `LOG_LEVEL` | `INFO` | Logging level |

## Document Structure

- **Document ID:** `jira-issue-{KEY}` (e.g. `jira-issue-FE-1047`)
- **Title:** `[KEY] Summary text`
- **Content:** Markdown-formatted document with all ticket fields
- **Datasource ID:** `jira-{project}-{name}` (e.g. `jira-fe-frontend`)
- **Metadata:** `issue_key`, `issue_type`, `status`, `priority`, `assignee`, `created`, `updated`, `source_uri`

## Running with Docker Compose

```bash
export RAG_SERVER_URL=http://host.docker.internal:9446
export JIRA_URL=https://your-org.atlassian.net
export JIRA_EMAIL=svc-account@your-org.com
export ATLASSIAN_TOKEN=your-api-token
export JIRA_PROJECTS='{"FE":[{"name":"Frontend","jql":"project = FE AND updated >= -730d ORDER BY updated DESC"}]}'
docker compose --profile jira up --build jira_ingestor
```

## Deployment Notes

- The service account (`JIRA_EMAIL`) must have **Browse Projects** permission for each configured project
- API tokens can be created at: https://id.atlassian.com/manage-profile/security/api-tokens
- For large projects, increase `JIRA_PAGE_SIZE` to 100 (Jira Cloud maximum) and set a longer `INIT_DELAY_SECONDS` to avoid overwhelming the RAG server during initial ingest
