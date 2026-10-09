# Quickstart: Connect a Gateway (target behaviour)

How an admin will connect a gateway once the phases in [plan.md](./plan.md) ship. A reviewer can use these steps to validate each phase.

## 1. Prepare the gateway (outside CAIPE)

- [ ] Serves the OpenAI API at `https://llm-gateway.example.com/v1`.
- [ ] Trusts the CAIPE token issuer's JWKS and expects `aud` = `LLM_GATEWAY_AUDIENCE` (or, for key auth, accepts per-agent keys).
- [ ] Defines limits keyed on `sub`, `agent_id` and `team_id` (or lets CAIPE set them through the adapter).
- [ ] Fails closed when its limit store is unreachable.
- [ ] Exposes model aliases equal to the `llm_models.model_id` values in use.

## 2. Point CAIPE at it

Set these environment variables on dynamic agents and the UI backend. The Helm values keys are defined in phase 1.

| Variable | Example |
|---|---|
| `LLM_GATEWAY_ENABLED` | `true` |
| `OPENAI_COMPATIBLE_BASE_URL` | `https://llm-gateway.example.com/v1` |
| `LLM_GATEWAY_AUTH` | `jwt` |
| `LLM_GATEWAY_AUDIENCE` | `llm-gateway` |
| `LLM_GATEWAY_ADAPTER` | `litellm` · `agentgateway` · `kong` · `agentrouter` · `none` |

- The adapter admin credential goes through the existing secret strategies, never in values.

## 3. Validate

Keep valid direct-provider configuration and credentials available for the disabled-mode check.

| Check | Expected |
|---|---|
| Admin → LLM Models → Sync | Gateway models listed; existing agents unchanged |
| Chat with an agent | Completion succeeds; the gateway logs `sub`, `agent_id`, `team_id` |
| Call the gateway with no or forged token | 401 |
| Set a tiny team limit, chat again | "Budget for team … exhausted" message, with a request-increase action |
| Autonomous task run | Usage attributed to the task owner, agent and team |
| Keep the gateway configured and reachable; set `LLM_GATEWAY_ENABLED=false` | Every migrated path completes through its direct provider; zero inference requests reach the gateway |

## 4. Swap gateways

- Change `OPENAI_COMPATIBLE_BASE_URL` and `LLM_GATEWAY_ADAPTER`, then re-run step 3. No agent edits.
