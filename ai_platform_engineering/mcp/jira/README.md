# 🧠 Jira MCP Server

## Setup MCP Server in Streamable HTTP Mode
- Setup UV

```bash
# On macOS and Linux.
curl -LsSf https://astral.sh/uv/install.sh | sh
```
- uv venv
```bash
uv venv && source .venv/bin/activate
```
- uv sync
```bash
uv sync
```
- Copy .env.example to .env
- Setup .env
```bash
ATLASSIAN_TOKEN=
ATLASSIAN_API_URL=
ATLASSIAN_EMAIL=
MCP_MODE=http
MCP_HOST=0.0.0.0
MCP_PORT=18000
```

```bash
set -a; source .env; set +a && uv run python mcp_jira/server.py
```

## Add Jira Comments

The `add_comment` tool supports both backward-compatible plain text and native
[Atlassian Document Format (ADF)](https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/)
for Jira Cloud rich comments.

- Use `body_format: "text"` (the default) with a string body. Existing callers
  continue to produce the same single-paragraph comment payload.
- Use `body_format: "adf"` with a complete ADF document to preserve headings,
  bold text, links, lists, code blocks, tables, and other Jira-native formatting.
- Use `visibility` with either a Jira role or group when the comment must be
  restricted, for example `{"type": "role", "value": "Administrators"}`.

Example rich-comment tool arguments:

```json
{
  "issue_key": "PROJ-123",
  "body_format": "adf",
  "visibility": {
    "type": "role",
    "value": "Administrators"
  },
  "body": {
    "type": "doc",
    "version": 1,
    "content": [
      {
        "type": "heading",
        "attrs": {"level": 2},
        "content": [{"type": "text", "text": "Analysis"}]
      },
      {
        "type": "paragraph",
        "content": [
          {"type": "text", "text": "Related issue: "},
          {
            "type": "text",
            "text": "PROJ-122",
            "marks": [
              {
                "type": "link",
                "attrs": {"href": "https://example.atlassian.net/browse/PROJ-122"}
              }
            ]
          }
        ]
      }
    ]
  }
}
```

The server validates the ADF document root before sending it to Jira REST API
v3. Jira performs the authoritative validation of nested ADF nodes and marks.

## MCP Inspector Tool

The **MCP Inspector** is a utility for inspecting and debugging MCP servers. It provides a visual interface to explore generated tools, models, and APIs.

### Installation

To install the MCP Inspector, use the following command:

```bash
npx @modelcontextprotocol/inspector
```

### Usage

Run the inspector in your project directory to analyze the generated MCP server:

```bash
npx @modelcontextprotocol/inspector
```

This will launch a web-based interface where you can:

- Explore available tools and their operations
- Inspect generated models and their schemas
- Test API endpoints directly from the interface

For more details, visit the [MCP Inspector Documentation](https://modelcontextprotocol.io/legacy/tools/inspector).

## 📚 Additional References

- [OpenAPI MCP Codegen](https://github.com/cnoe-io/openapi-mcp-codegen)
