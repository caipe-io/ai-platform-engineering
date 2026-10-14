# Quickstart: Connect a Gateway (target behaviour)

How an admin will connect a gateway once the phases in [plan.md](./plan.md) ship. A reviewer can use these steps to validate each phase.

## 1. Prepare the gateway (outside CAIPE)

- [ ] Serves the OpenAI API at `https://llm-gateway.example.com/v1`.
- [ ] Trusts the CAIPE token issuer's JWKS and expects `aud` = `LLM_GATEWAY_AUDIENCE` (or, for key auth, accepts per-agent keys).
- [ ] Defines limits keyed on `sub`, `agent_id` and `team_id` (or lets CAIPE set them through the adapter).
- [ ] Fails closed when its limit store is unreachable.
- [ ] Exposes model aliases equal to the `llm_models.model_id` values in use.

## 2. Point CAIPE at it

Set these once under `global.llmGateway` in Helm ([plan.md](./plan.md#helm-and-compose)), or in `.env` for Compose.

| Variable | Example |
|---|---|
| `LLM_GATEWAY_ENABLED` | `true` |
| `LLM_GATEWAY_BASE_URL` | `https://llm-gateway.example.com/v1` |
| `LLM_GATEWAY_AUTH` | `jwt` |
| `LLM_GATEWAY_AUDIENCE` | `llm-gateway` |
| `LLM_GATEWAY_ADAPTER` | `litellm` · `agentgateway` · `kong` · `agentrouter` · `none` |

- `LLM_GATEWAY_ADAPTER` selects management integration; `none` does not disable gateway routing. See the [adapter comparison](./contracts/gateway-adapter.md).
- The adapter admin credential is needed only for management integration and goes through the existing secret strategies, never in values. Inference credentials remain required with `none`.
- With `none`, prepare required gateway identities and limits externally and provision inference credentials for the selected auth mode.

## 3. Validate

Keep valid direct-provider configuration and credentials available for the disabled-mode check.

| Check | Expected |
|---|---|
| Adapter supports `models.list`: Admin → LLM Models → Sync | Gateway models persist in `llm_models`; existing model IDs remain usable |
| Adapter lacks `models.list`, including `none`: configure or add model entries with IDs matching gateway aliases | Sync is hidden; catalogue entries remain selectable subject to permissions |
| Chat with an agent | Completion succeeds; the gateway logs `sub`, `agent_id`, `team_id` |
| Call the gateway with no or forged token | 401 |
| Set a tiny team limit through CAIPE where supported, otherwise in the gateway; chat again | "Budget for team … exhausted" message, with a request-increase action |
| Autonomous task run | Usage attributed to the task owner, agent and team |
| Keep the gateway configured and reachable; set `LLM_GATEWAY_ENABLED=false` | Every migrated path completes through its direct provider; zero inference requests reach the gateway |

## 4. Swap gateways

- Change `LLM_GATEWAY_BASE_URL` and `LLM_GATEWAY_ADAPTER`, then re-run step 3. No agent edits.
