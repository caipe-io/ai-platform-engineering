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

Keep valid direct-provider configuration and credentials in the deployment secret store, outside gateway-enabled inference pods. For the disabled-mode check, apply the mode change through Helm/GitOps so it restores provider secret references and replaces pods; wait for rollout completion. Compose must recreate containers with mode-specific credential injection. Missing secrets must not be treated as a successful transition.

| Check | Expected |
|---|---|
| Adapter supports `models.list`: Admin → LLM Models → Sync | Gateway models persist in `llm_models`; existing model IDs remain usable |
| Adapter lacks `models.list`, including `none`: configure or add model entries with IDs matching gateway aliases | Sync is hidden; catalogue entries remain selectable subject to permissions |
| Chat with an agent | Completion succeeds; the gateway logs `sub`, `agent_id`, `team_id` |
| Call the gateway with no or forged token | 401 |
| Set a tiny team limit through CAIPE where supported, otherwise in the gateway; chat again | The request is rejected and CAIPE reports the failure without inferred budget-specific advice or direct-provider fallback |
| Autonomous task run | Usage attributed to the task owner, agent and team |
| Keep the gateway configured and reachable; deploy `LLM_GATEWAY_ENABLED=false` with restored provider secret references and wait for pod replacement | Every migrated path completes through its direct provider; zero inference requests reach the gateway |

When rotating a Secret consumed by an inference workload, wait for the Secret update to complete, then perform and verify a rolling restart so new pods load the new credentials. Chart-managed Secret checksums trigger the rollout during deployment; externally managed Secrets require the operator or deployment pipeline to trigger it explicitly.

## 4. Swap gateways

- Change `LLM_GATEWAY_BASE_URL` and `LLM_GATEWAY_ADAPTER`, then re-run step 3. No agent edits.
