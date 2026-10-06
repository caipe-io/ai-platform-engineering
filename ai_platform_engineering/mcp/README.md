# MCP Servers

Per-tool **MCP (Model Context Protocol) servers**. Each subdirectory is one
self-contained server (ArgoCD, AWS, Jira, SharePoint, …) consumed by the dynamic agents
runtime.

## Layout

```
mcp/
  <name>/                 # one MCP server per tool
    server.py             # entrypoint — defines main()
    __main__.py           # `python __main__.py` → server.main()
    tools/ api/ models/   # server implementation (varies per server)
    pyproject.toml        # isolated uv project (package = false)
    Makefile              # includes ../mcp-common.mk
    tests/                # optional
  common/
    mcp-auth/             # shared `mcp-agent-auth` package (editable dep)
  mcp-common.mk           # shared Makefile included by every server
  README.md
```

Each server is a **flat module layout**: `server.py`, `tools/`, `api/`, etc.
live directly at the server root — there is no inner `mcp_<name>/` package
wrapper. Imports are top-level (`from tools import ...`, `from server import
main`).

Servers that need request auth depend on `mcp-agent-auth` from
`common/mcp-auth` via:

```toml
[tool.uv.sources]
mcp-agent-auth = { path = "../common/mcp-auth", editable = true }
```

`github/` is special: it uses the **external** official image
`ghcr.io/github/github-mcp-server` and has no local server — see its README.

## Adding / running a server

Each server is an isolated uv project run from source:

```bash
cd mcp/<name>
make run          # uv sync + run server.py (see ../mcp-common.mk)
make test         # run tests/ if present
```

Per-server Makefiles only set `AGENT_NAME` and include `../mcp-common.mk`:

```makefile
AGENT_NAME = <name>
include ../mcp-common.mk
```

## mcp-common.mk variables

- `AGENT_NAME` (required) — server name (e.g. `argocd`, `jira`)
- `MCP_ENTRYPOINT` (optional, default `server.py`) — entrypoint module
- `MCP_MODE` (optional, default `STDIO`) — `STDIO` or `HTTP`
- `MCP_HOST` (optional, default `localhost`) — host for HTTP mode
- `MCP_PORT` (optional, default `8000`) — port for HTTP mode

## mcp-common.mk targets

- `setup-uv` / `uv-venv` / `uv-sync` — install uv, create venv, sync deps
- `copy-env` / `verify-env` / `setup-env` — `.env` / `.env.mcp` handling
- `run` (default) — sync deps and run the entrypoint
- `test` — run `tests/` if present
- `help` — list targets
