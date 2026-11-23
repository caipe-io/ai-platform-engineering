# LLM gateway conformance suite

Black-box checks that a bring-your-own gateway meets
[contract ②](../../docs/docs/specs/2026-10-10-byo-llm-gateway-budgets-quotas/contracts/routing-backend-contract.md).
Key-mode checks only for now; JWT and agent-path checks are added as those tasks land.

```
pytest ──HTTP──> gateway under test ──> provider (or harness mock)
   │
   └─> report.json: gateway, version, auth mode, PASS / FAIL / NOT_RUN per check
```

## Checks

| Check | Contract item |
|---|---|
| `test_no_credential_is_401`, `test_invalid_key_is_401`, `test_revoked_key_is_401` | Identity verification |
| `test_models_endpoint_lists_model`, `test_completion`, `test_streaming_completion`, `test_tool_call` | OpenAI-compatible endpoint |
| `test_agent_limit_rejects`, `test_team_limit_rejects` | Limits by identity, limit rejection |
| `test_upstream_error_keeps_class[429/500/402]` | Error passthrough |
| `test_limit_store_down_fails_closed` | Fail closed (separate run, store stopped) |

A check without its inputs is skipped and reported as `NOT_RUN`, never as a pass.

## Inputs

All variables start with `LLM_GW_CONFORMANCE_`.

| Variable | Meaning |
|---|---|
| `BASE_URL` | Gateway URL (required) |
| `AUTH` | `key` (default) or `jwt` |
| `MODEL` | Model name that returns completions and tool calls |
| `KEY` | Valid per-agent key |
| `REVOKED_KEY` | Key that was revoked |
| `AGENT_LIMIT_KEY` / `TEAM_LIMIT_KEY` | Keys whose agent / team limit is nearly spent |
| `ERROR_MODELS` | `429=<model>,500=<model>,402=<model>`: models whose upstream returns that error |
| `LIMIT_STORE_DOWN` | `1` only for the fail-closed run, after stopping the limit store |
| `LIMIT_STORE_GRACE_SECONDS` | How long the gateway may keep admitting cached keys after the store goes down (default `0`) |
| `GATEWAY`, `GATEWAY_VERSION`, `REPORT` | Recorded in the JSON report written to `REPORT` |

## Run against the local LiteLLM OSS harness

```bash
docker compose -f tests/llm_gateway_conformance/harness/compose.yaml up -d
eval "$(uv run python tests/llm_gateway_conformance/harness/provision_litellm.py http://localhost:4000 sk-conformance-master)"
export LLM_GW_CONFORMANCE_BASE_URL=http://localhost:4000 LLM_GW_CONFORMANCE_GATEWAY=litellm-oss \
  LLM_GW_CONFORMANCE_GATEWAY_VERSION=1.108.3 LLM_GW_CONFORMANCE_LIMIT_STORE_GRACE_SECONDS=15 \
  LLM_GW_CONFORMANCE_ERROR_MODELS=429=mock-429,500=mock-500,402=mock-402-quota

LLM_GW_CONFORMANCE_REPORT=report-up.json uv run pytest tests/llm_gateway_conformance
docker compose -f tests/llm_gateway_conformance/harness/compose.yaml stop litellm-db
LLM_GW_CONFORMANCE_LIMIT_STORE_DOWN=1 LLM_GW_CONFORMANCE_REPORT=report-down.json uv run pytest tests/llm_gateway_conformance
```

- The harness is for testing only. CAIPE does not ship or operate a gateway.
- The provision script plays the operator: it creates teams and per-agent keys through the LiteLLM admin API (adapter `none`).

## LiteLLM OSS notes (1.108.3)

- Budget rejection returns `422` with type `budget_exceeded`. A team `max_budget` of `0` is not enforced, so the harness uses a tiny budget.
- With the database down, keys in LiteLLM's auth cache are still admitted, unmetered, until `user_api_key_cache_ttl` expires (default 60 s; the harness sets 10 s). After that, requests are rejected with `503`, or `404` for team lookups.
- Upstream `429`, `500` and `402` keep their status; the `402` keeps the provider's "quota" wording.
