# Agent context HMAC (`CAIPE_AGENT_CONTEXT_HMAC_SECRET`)

When MCP traffic routes through **AgentGateway**, authorization happens in two layers:

1. **Coarse gate** — does this caller have `can_call` on `mcp_gateway:list`?
2. **Per-agent tool gate** (on `tools/call`) — does this caller `can_use` the dynamic agent, and does that agent `can_call` the specific MCP tool?

Layer 2 needs to know **which dynamic agent** initiated the call. Callers cannot send a bare `agent_id` header — that would be forgeable. Instead, trusted platform services sign a short-lived payload with a **shared HMAC secret**.

## What the secret does

`CAIPE_AGENT_CONTEXT_HMAC_SECRET` is a symmetric key used to:

- **Sign** outbound AgentGateway MCP requests (attach trusted `agent_id` context)
- **Verify** those signatures in the **openfga-authz-bridge** before running per-tool OpenFGA checks

Signers build two headers:

| Header | Contents |
|--------|----------|
| `X-CAIPE-Agent-Context` | Base64url JSON: `{ "agent_id", "iat", "exp" }` (default TTL 300s) |
| `X-CAIPE-Agent-Context-Signature` | HMAC-SHA256 of the encoded payload using the shared secret |

The bridge verifies the signature, rejects expired payloads, then checks:

```text
user:<sub> can_use agent:<agent_id>
agent:<agent_id> can_call tool:<mcp_server>/<tool_name>
```

Without the secret, signers omit the headers. AgentGateway may still allow coarse listing traffic, but **`tools/call` can 403** when per-agent `allowed_tools` enforcement is expected.

## Who must share the secret

| Component | Role |
|-----------|------|
| **dynamic-agents** | Signs context on runtime MCP `tools/call` via AgentGateway |
| **caipe-ui** (BFF) | Signs context for MCP probe / test-tool diagnostics |
| **openfga-authz-bridge** | Verifies signatures and enforces per-agent tool tuples |

All three must use the **same value**. Store it only in runtime secrets (Kubernetes Secret, Vault/ESO, or local `.env` — never commit real values).

Generate a dev value:

```bash
openssl rand -hex 32
```

## Docker Compose (local dev)

Root `.env.example` documents the variable next to `AGENT_GATEWAY_URL`. `docker-compose.dev.yaml` passes it to **dynamic-agents** and **openfga-authz-bridge**.

When `AGENT_GATEWAY_URL` is set but the secret is empty, dynamic-agents logs a startup warning (non-fatal).

## Kubernetes / Helm

Wire the same key on **both** workloads:

```yaml
dynamic-agents:
  agentContext:
    existingSecret:
      name: caipe-ui-secret
      key: CAIPE_AGENT_CONTEXT_HMAC_SECRET

openfga-authz-bridge:
  agentContext:
    existingSecret:
      name: caipe-ui-secret
      key: CAIPE_AGENT_CONTEXT_HMAC_SECRET
```

`setup-caipe.sh` (AgentGateway enabled):

- Patches `CAIPE_AGENT_CONTEXT_HMAC_SECRET` into `caipe-ui-secret` (from `.env` or generated once)
- Passes the Helm `--set` flags above for bridge and dynamic-agents

The dynamic-agents chart `NOTES.txt` warns on `helm install` when gateway MCP routing is enabled but `agentContext.existingSecret.name` is empty.

## Related issues

- [#1920](https://github.com/caipe-io/ai-platform-engineering/issues/1920) — signed agent context for per-agent `tools/call`
- [#1928](https://github.com/caipe-io/ai-platform-engineering/issues/1928) — 403 on `tools/call` when HMAC was missing on dynamic-agents in Kubernetes

## Code references

| Area | File |
|------|------|
| Sign (Python) | `ai_platform_engineering/dynamic_agents/src/dynamic_agents/services/mcp_client.py` (`build_agent_context_headers`) |
| Sign (BFF) | `ui/src/lib/mcp-http-server-client.ts` |
| Verify + enforce | `deploy/openfga/bridge/main.py` (`_agent_id_from_context_headers`) |
| Helm — dynamic-agents | `charts/ai-platform-engineering/charts/dynamic-agents/templates/deployment.yaml` |
| Helm — bridge | `charts/ai-platform-engineering/charts/openfga-authz-bridge/templates/deployment.yaml` |
| Chart tests | `tests/test_dynamic_agents_chart_keycloak_env.py` |
