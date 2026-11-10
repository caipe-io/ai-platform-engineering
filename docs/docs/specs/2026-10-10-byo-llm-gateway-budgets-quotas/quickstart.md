# Quickstart: Connect a Gateway (target behaviour)

How an admin will connect a gateway once the phases in [plan.md](./plan.md) ship. A reviewer can use these steps to validate each phase.

## 1. Prepare the gateway (outside CAIPE)

- [ ] Serves the OpenAI API at `https://llm-gateway.example.com/v1`.
- [ ] Trusts the CAIPE token issuer's JWKS and expects `aud` = `LLM_GATEWAY_AUDIENCE` (or, for key auth, accepts per-agent keys).
- [ ] Defines limits keyed on `sub`, `agent_id` and `team_id` (or lets CAIPE set them through the adapter).
- [ ] Fails closed when its limit store is unreachable.
- [ ] Exposes model aliases equal to the `llm_models.model_id` values in use.

## 2. Point CAIPE at it

Before enabling routing, complete the applicable identity preparation in [T102–T105](./tasks.md#phase-1-identity-preparation-and-agent-data-plane): Keycloak exchange setup for JWT mode, existing-agent identity backfill, default-team and new-agent provisioning, and the AI-assist system identity. Prepare required gateway principals and credentials for the selected auth mode. For phase 4 workloads, also complete T401/T402 identity preparation. Missing preparation must block enablement.

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

Before gateway checks, deploy `LLM_GATEWAY_ENABLED=true` and wait for workload replacement with provider credentials excluded. Use an isolated test team for limit checks. Run the disabled-mode check in an isolated deployment; if it must run on the live deployment, pause and drain live inference first, including scheduled/background work. Keep live inference paused until gateway mode is restored, workload replacement completes, and gateway routing and intended limits are verified. Only controlled validation calls may run during this pause.

Keep valid direct-provider configuration and credentials in the deployment secret store, outside gateway-enabled inference pods. For the disabled-mode check, apply the mode change through Helm/GitOps so it restores provider secret references and replaces pods; wait for rollout completion. Compose must recreate containers with mode-specific credential injection. Missing secrets must not be treated as a successful transition.

| Check | Expected |
|---|---|
| Adapter supports `models.list`: Admin → LLM Models → Sync | Gateway models persist in `llm_models`; existing model IDs remain usable |
| Adapter lacks `models.list`, including `none`: configure or add model entries with IDs matching gateway aliases | Sync is hidden; catalogue entries remain selectable subject to permissions |
| Chat with an agent | Completion succeeds. JWT mode: verified user (`sub`), agent and team attribution. Key mode: verified agent/team bindings; any user attribution is unverified and `sub` is not required. |
| Call the gateway without credentials, then separately with invalid credentials for the selected auth mode | Both requests return 401 |
| JWT mode: change an identity claim in a valid test token without re-signing it, then call the gateway | 401; invalid signatures are rejected |
| Set a tiny limit on an isolated test team through CAIPE where supported, otherwise in the gateway; chat as that team again | The request is rejected and CAIPE reports the failure without inferred budget-specific advice or direct-provider fallback |
| Autonomous task run | JWT mode: verified task-owner, agent and team attribution. Key mode: verified agent/team bindings; task-owner attribution is unverified. |
| Keep the gateway configured and reachable; deploy `LLM_GATEWAY_ENABLED=false` with restored provider secret references and wait for pod replacement | Every migrated path completes through its direct provider; zero inference requests reach the gateway |

If a production team must be used for the limit check, record its intended limit and reset window first. Restore the intended limit and remaining allowance afterward, accounting for test usage; verify the temporary test limit is no longer active.

After the disabled-mode check, redeploy `LLM_GATEWAY_ENABLED=true` and wait for replacement pods or recreated containers. Verify provider credentials and model-invoking ambient identities are excluded, inference reaches the configured gateway, and the intended limits apply before declaring validation complete.

When rotating a Secret consumed by an inference workload, wait for the Secret update to complete, then perform and verify a rolling restart so new pods load the new credentials. Chart-managed Secret checksums trigger the rollout during deployment; externally managed Secrets require the operator or deployment pipeline to trigger it explicitly.

## 4. Swap gateways

- Check the replacement gateway's inference authentication requirements. `LLM_GATEWAY_ADAPTER` selects management integration; it does not select or change `LLM_GATEWAY_AUTH`.
- Prepare authentication before switching traffic:
  - JWT mode: configure the replacement to trust the token issuer and validate the configured audience and required identity claims.
  - Key mode: provision per-agent keys in the replacement gateway with the required agent/team bindings, and store them in CAIPE's credentials store. Keys from the previous gateway must not be assumed valid on the replacement.
- Prepare the replacement adapter's management credential where required; keep it BFF-only and separate from inference credentials.
- Before switching traffic, prepare the replacement's user, agent and team principals as applicable to the selected auth mode. Configure their budgets and quotas, and compare the effective limits and reset windows with the old gateway. Verify that exceeding a configured limit rejects the request; successful authentication alone is insufficient.
- Account for usage already consumed in the current budget window. Copying a full budget into a gateway with zero recorded usage can grant additional spending. Preserve consumed usage where supported, or set a temporary remaining allowance until the intended reset (for example, a $100 monthly budget with $80 consumed leaves $20). Include usage during the cutover; pause affected inference if necessary to establish the remaining allowance safely.
- Budget migration is operator-managed. CAIPE does not automatically transfer gateway limits or usage, or maintain a second authoritative budget database. With adapter `none`, prepare and verify these settings directly in the replacement gateway.
- Before rollout, inspect component-level `LLM_GATEWAY_BASE_URL` overrides in Helm values, Harness manifests and Compose configuration. Remove stale overrides or update them to the replacement endpoint; changing the global URL alone does not replace explicit local values.
- Deploy `LLM_GATEWAY_BASE_URL`, `LLM_GATEWAY_ADAPTER`, `LLM_GATEWAY_AUTH`, the audience where applicable, and the corresponding credential references together through Helm/GitOps or Compose. Wait for credential synchronization and the affected workload rollout or container recreation to complete.
- Re-run step 3 against the replacement gateway, verifying inference and attribution for the selected auth mode. Check every migrated workload's effective endpoint and gateway traffic; after rollout, no inference should reach the old gateway. Finish with gateway mode enabled and intended limits restored. No agent edits are required.
