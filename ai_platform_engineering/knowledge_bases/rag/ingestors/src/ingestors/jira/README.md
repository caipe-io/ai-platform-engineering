# Jira Ingestor

Ingests Jira issues into RAG. Each datasource uses one JQL query, and each
matching issue becomes a document.

## Datasource configuration

Create project queries in the Web UI, or seed view-only queries through
`rag_sources` in `config/app-config.yaml` (Compose) or
`caipe-ui.appConfig.rag_sources` (Helm):

```yaml
rag_sources:
  - source_type: jira_project
    project_key: EXAMPLE
    source_slug: primary
    name: example-project
    search_with_teams: [primary]
    jql: project = EXAMPLE ORDER BY updated DESC
    include_comments: true
    include_links: true
    custom_fields:
      severity: customfield_10001
    reload_interval: 86400
```

`source_slug` distinguishes multiple queries for the same project. Changing
or removing a seeded datasource requires changing the application config and
restarting the UI so it can reconcile the seed.

## Connector environment

Required:

| Variable | Description |
|---|---|
| `JIRA_URL` | Jira base URL, such as `https://jira.example.com`. |
| `JIRA_EMAIL` | Service-account email. |
| `ATLASSIAN_TOKEN` | API token for the service account. |
| `RAG_SERVER_URL` | RAG server URL. |

Optional:

| Variable | Default | Description |
|---|---:|---|
| `JIRA_PAGE_SIZE` | `100` | Issues requested per page. |
| `INIT_DELAY_SECONDS` | `0` | Startup delay in seconds. |
| `LOG_LEVEL` | `INFO` | Logging level. |

The service account needs Browse Projects permission for each configured query.

## Behavior

- Datasource ID: `jira-{project_key}-{source_slug}`, normalized to lowercase.
- ADF descriptions and comments are converted to plain text.
- Linked issues and configured custom fields are included.
- Every scheduled reload executes the persisted JQL.
