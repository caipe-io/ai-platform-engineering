# Quickstart: Connect a Gateway (target behaviour)

How an admin will connect a gateway once the phases in [plan.md](./plan.md) ship.

## 1. Prepare the gateway (outside CAIPE)

- [ ] Serves the OpenAI API at `https://llm-gateway.example.com/v1`.
- [ ] Trusts the CAIPE token issuer's JWKS and expects `aud` = `LLM_GATEWAY_AUDIENCE` (or, for key auth, accepts per-agent keys).
- [ ] Defines limits for the verified agent/team binding; JWT mode also uses verified `sub`. User attribution and per-user limits are best-effort in key mode. Configure limits externally or through a supported adapter.
- [ ] Fails closed when its limit store is unreachable.
- [ ] Exposes model aliases equal to the `llm_models.model_id` values in use.

## 2. Point CAIPE at it

Before enabling routing, confirm:

- Existing and new agents have prepared identities, owning teams (or the default team), and gateway credentials.
- The AI-assist system identity and permissions are provisioned.
- JWT mode has working token acquisition and refresh; key mode has provisioned per-agent keys.
- If enabling RAG or ontology, their query and background-work identities and credentials are ready.

Missing preparation must block enablement. See [identity preparation](./tasks.md#phase-1-identity-preparation-and-agent-data-plane) and [RAG prerequisites](./tasks.md#phase-4-rag-and-ontology).

Set these once under `global.llmGateway` in Helm ([plan.md](./plan.md#helm-and-compose)), or in `.env` for Compose.

| Variable | Example |
|---|---|
| `LLM_GATEWAY_ENABLED` | `true` |
| `LLM_GATEWAY_BASE_URL` | `https://llm-gateway.example.com/v1` |
| `LLM_GATEWAY_AUTH` | `key` for LiteLLM OSS; `jwt` for AgentGateway / AgentRouter |
| `LLM_GATEWAY_AUDIENCE` | `llm-gateway` |
| `LLM_GATEWAY_ADAPTER` | `litellm` · `agentgateway` · `agentrouter` · `kong` · `none` |

- `LLM_GATEWAY_ADAPTER` selects management integration; `none` does not disable gateway routing. See the [adapter comparison](./contracts/gateway-adapter.md).
- The adapter admin credential is needed only for management integration and goes through the existing secret strategies, never in values. Inference credentials remain required with `none`.
- With `none`, prepare required gateway identities and limits externally and provision inference credentials for the selected auth mode.

## 3. Verify the connection

Deploy with routing enabled and wait for workload replacement. Confirm direct-provider credentials and model-invoking ambient identities are excluded from gateway-enabled workloads; see [deployment guidance](./plan.md#credential-isolation-and-mode-transitions).

| Check | Expected |
|---|---|
| Select a gateway model | Sync through Admin → LLM Models if the adapter supports `models.list`; otherwise configure or add model entries matching gateway aliases. Model access permissions still apply. |
| Chat with an agent | Completion succeeds through the configured gateway. JWT mode verifies user, agent and team attribution; key mode verifies agent/team bindings, with unverified user attribution. |
| Set a tiny limit on an isolated test team and exceed it | The gateway rejects the request; CAIPE reports failure without inferred budget-specific advice or direct-provider fallback. Configure the limit through a supported adapter or directly in the gateway. |

Use an isolated test team for limit checks. If a production team must be used, record its intended limit and reset window first, then restore its intended limit and remaining allowance accounting for test usage. Verify the temporary test limit is no longer active.

Complete the [detailed validation](#4-detailed-validation) for authentication and deployment-mode acceptance checks. It includes the isolation, pause and restoration requirements for testing disabled mode.

For ongoing operations, see [secret rotation](./plan.md#secret-rotation) and [switching gateways](#5-switching-gateways).

## 4. Detailed validation

Complete the [connection checks](#3-verify-the-connection) first, including attribution and limit enforcement. These additional acceptance checks also apply when switching gateways. Implementation must pass the [conformance contract](./contracts/routing-backend-contract.md).

Before gateway checks, deploy `LLM_GATEWAY_ENABLED=true` and wait for workload replacement with provider credentials excluded. Use an isolated test team for limit checks. Run the disabled-mode check in an isolated deployment; if it must run on the live deployment, pause and drain live inference first, including scheduled/background work. Keep live inference paused until gateway mode is restored, workload replacement completes, and gateway routing and intended limits are verified. Only controlled validation calls may run during this pause.

Keep valid direct-provider configuration and credentials in the deployment secret store, outside gateway-enabled inference pods. For the disabled-mode check, apply the mode change through Helm/GitOps so it restores provider secret references and replaces pods; wait for rollout completion. Compose must recreate containers with mode-specific credential injection. Missing secrets must not be treated as a successful transition.

| Check | Expected |
|---|---|
| Call the gateway without credentials, then separately with invalid credentials for the selected auth mode | Both requests return 401 |
| JWT mode: change an identity claim in a valid test token without re-signing it, then call the gateway | 401; invalid signatures are rejected |
| Autonomous task run | JWT mode: verified task-owner, agent and team attribution. Key mode: verified agent/team bindings; task-owner attribution is unverified. |
| Keep the gateway configured and reachable; deploy `LLM_GATEWAY_ENABLED=false` with restored provider secret references and wait for pod replacement | Every migrated path completes through its direct provider; zero inference requests reach the gateway |

After the disabled-mode check, redeploy `LLM_GATEWAY_ENABLED=true` and wait for replacement pods or recreated containers. Verify provider credentials and model-invoking ambient identities are excluded, inference reaches the configured gateway, and the intended limits apply before declaring validation complete.

## 5. Switching gateways

- Check the replacement gateway's inference authentication requirements. `LLM_GATEWAY_ADAPTER` selects management integration; it does not select or change `LLM_GATEWAY_AUTH`.
- Prepare authentication before switching traffic:
  - JWT mode: configure the replacement to trust the token issuer and validate the configured audience and required identity claims.
  - Key mode: provision per-agent keys in the replacement gateway with the required agent/team bindings, and store them in CAIPE's credentials store. Keys from the previous gateway must not be assumed valid on the replacement.
- Prepare the replacement adapter's management credential where required; keep it BFF-only and separate from inference credentials.
- Before switching traffic, prepare the replacement's user, agent and team principals as applicable to the selected auth mode. Configure their budgets and quotas, and compare the effective limits and reset windows with the old gateway. Verify that exceeding a configured limit rejects the request; successful authentication alone is insufficient.
- Account for usage already consumed in the current budget window. Copying a full budget into a gateway with zero recorded usage can grant additional spending. Preserve consumed usage where supported, or set a temporary remaining allowance until the intended reset (for example, a $100 monthly budget with $80 consumed leaves $20). Include usage during the cutover; pause affected inference if necessary to establish the remaining allowance safely.
- Budget migration is operator-managed. CAIPE does not automatically transfer gateway limits or usage, or maintain a second authoritative budget database. With adapter `none`, prepare and verify these settings directly in the replacement gateway.
- Before rollout, inspect component-level overrides for `LLM_GATEWAY_BASE_URL`, `LLM_GATEWAY_AUTH`, `LLM_GATEWAY_AUDIENCE` and associated credential references in Helm values, Harness manifests and Compose configuration. Remove stale overrides or update them for the replacement gateway; global changes do not replace explicit local values. When switching to LiteLLM OSS, ensure no migrated inference workload retains a JWT-mode override.
- Deploy `LLM_GATEWAY_BASE_URL`, `LLM_GATEWAY_ADAPTER`, `LLM_GATEWAY_AUTH`, the audience where applicable, and the corresponding credential references together through Helm/GitOps or Compose. Wait for credential synchronization and the affected workload rollout or container recreation to complete.
- Run the [connection checks](#3-verify-the-connection) and [detailed validation](#4-detailed-validation) against the replacement gateway, verifying inference and attribution for the selected auth mode. Check every migrated inference workload's effective endpoint, authentication mode, audience where applicable, and credential references without exposing credential values. Verify gateway traffic; after rollout, no inference should reach the old gateway. Finish with gateway mode enabled and intended limits restored. No agent edits are required.
