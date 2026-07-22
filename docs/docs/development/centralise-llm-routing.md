# Centralise LLM Routing and Provider Selection

Route every CAIPE agent's LLM traffic through one central endpoint, so provider
choice is a single edit instead of per-agent config. Default-off; opt-in per
deployment.

## Why

- **One place to choose the provider.** Agents inherit `LLM_PROVIDER` /
  `OPENAI_ENDPOINT` from `global`; a new agent inherits it with no extra config.
- **One control point.** Every agent speaks the OpenAI chat-completions protocol
  to the proxy, which translates to the real upstream (OpenAI, Azure, Bedrock,
  Anthropic). Swap the upstream centrally, not per agent.
- **No agent code changes.** Agents already resolve their model through
  `cnoe_agent_utils.LLMFactory` with `LLM_PROVIDER=openai`; this feature only
  wires where that endpoint points.

## How it fits together

```
umbrella values.yaml (global)                    litellm proxy (when enabled)
  LLM_PROVIDER=openai ───────────┐                  model_list: request-model → upstream
  OPENAI_ENDPOINT ───────────────┼─► every agent      upstream provider key (Secret)
  llmSecrets:OPENAI_API_KEY ─────┘   (shared cred)     master_key == shared cred

  (BYO: OPENAI_ENDPOINT → your external proxy, subchart disabled)
```

The shared credential every agent presents as `OPENAI_API_KEY` is also the
proxy's `master_key`. The **real, cost-bearing** upstream key lives only on the
proxy, injected from a Secret, and the proxy's Service is network-restricted so
that key is never reachable off-cluster.

## A. In-stack default proxy (Helm)

### 1. Enable the subchart

```yaml
llmRouting:
  litellm:
    enabled: true          # default is false
```

This is the dependency condition in the parent `Chart.yaml`. With it on and a
**Helm-generated** llm-secret (`global.createLlmSecret: true`), the parent chart
auto-injects `LLM_PROVIDER=openai` and `OPENAI_ENDPOINT=http://<release>-litellm:4000/v1`
into the shared secret unless you set them yourself. Every agent inherits them
via `envFrom`.

For the other two secret strategies, put the routing keys in the secret yourself
(Helm does not modify a secret it did not generate):

| Secret strategy | Values file | What to add |
|---|---|---|
| Helm-generated | `values.yaml` (`global.llmSecrets.data`) | auto-injected; override only to customise |
| Existing secret | `values-existing-secrets.yaml` | `LLM_PROVIDER`, `OPENAI_ENDPOINT`, `OPENAI_API_KEY` in the referenced secret |
| External Secrets (ESO) | `values-external-secrets.yaml` | source those three keys from your store |

### 2. Configure the upstream provider (once, on the proxy)

Supply the real provider key via the secret framework and map the models agents
request to a real upstream. Keep provider keys in Secrets, never in plaintext
values.

The real upstream key lives in a **proxy-only** secret (`upstreamSecret`), separate
from the agent-facing shared credential, agents never see it. The proxy reads it via
`os.environ/*` refs in `modelList`.

```yaml
litellm:
  upstreamSecret:
    name: my-llm-provider-secret         # existing/ESO secret: ANTHROPIC_API_KEY, AWS_*, AZURE_OPENAI_*
  modelList:
    - model_name: gpt-4o                 # what agents request
      litellm_params:
        model: azure/gpt-4o              # the real upstream + native params
        api_base: os.environ/AZURE_OPENAI_ENDPOINT
        api_key: os.environ/AZURE_OPENAI_API_KEY
```

### 3. Deploy and verify

- Proxy `/health` is OK and network-restricted.
- A request to `/v1/chat/completions` **without** the shared credential returns
  `401` (a malformed key may return `400`); either way the upstream key is never
  served unauthenticated.
- Any agent (e.g. GitHub) returns a completion via the proxy, with no agent code
  or per-agent provider config changed.

### 4. Swap the provider centrally

Change the upstream in `model_list` (openai → azure → bedrock → anthropic). Every
agent uses the new provider after one edit.

## `provider=openai` and non-OpenAI upstreams

`LLM_PROVIDER=openai` is the **wire protocol** every agent speaks, **not** "traffic
goes to OpenAI". The proxy translates that protocol to whatever upstream you
configure. A Bedrock- or Anthropic-native upstream returns correct completions
via translation, with no agent-side change. Operators currently pointing agents
directly at a non-OpenAI provider move that provider selection onto the proxy's
`model_list`; the agents keep speaking `openai`.

## Error passthrough

Retries and fallbacks are disabled at the proxy (`num_retries: 0`). When the
upstream errors while the proxy is healthy, the agent observes the same error
class as a direct call — `429` stays `429`, `5xx` stays `5xx`, timeouts surface
as timeouts. No masking, no silent retry.

## Fail-closed

Routing fails closed. If the proxy is down or misconfigured, agent LLM calls
error rather than falling back to a direct or unrouted provider call. There is no
fallback policy that bypasses the endpoint.

The proxy runs as a **single instance** in v1 (HA deferred), so it is a single
point of failure for agent LLM traffic — an accepted, documented tradeoff.

## Reversibility

Central routing is opt-in and reversible:

1. Set `llmRouting.litellm.enabled: false`.
2. Restore the prior `LLM_PROVIDER` / endpoint (and, for a Helm-generated secret,
   remove the auto-injected `OPENAI_ENDPOINT` override if you set one).

Agents return to direct provider calls with no half-configured state and no
orphaned secrets or config.

## B. Bring-your-own proxy

To use your own OpenAI-compatible routing layer instead of the bundled one:

- Leave the subchart **disabled** (`llmRouting.litellm.enabled: false`).
- Point `OPENAI_ENDPOINT` (in `global.llmSecrets.data`, or your existing/external
  secret) at your proxy, and set the shared credential to its key.
- Your BYO proxy must itself translate the OpenAI protocol to your real upstream —
  the agents only ever speak `openai`.

The same conformance checks apply (401 on missing credential, transparent error
passthrough, fail-closed).

## C. Local Docker Compose

The proxy ships as an **opt-in** Compose profile; it is not in the default
minimal profile.

```bash
# enable the routing profile alongside your usual profiles
COMPOSE_PROFILES="...,llm-routing" docker compose --env-file .env up -d
```

In `.env`, set `LITELLM_MASTER_KEY`, then `OPENAI_API_KEY=${LITELLM_MASTER_KEY}`
and `OPENAI_ENDPOINT=http://litellm:4000/v1`. Configure upstreams in
`deploy/litellm/config.yaml` (`model_list`). Disabling the profile returns agents
to direct calls.

## Latency

There is no hard SLO (SC-008); the added routing hop is measured and documented.
On a local `kind` cluster the proxy's own in-cluster overhead (the `/health`
endpoint, no LLM) was **~1–4 ms**, while a full chat round-trip was ~800 ms —
i.e. the hop is negligible relative to the upstream LLM call, which dominates.

## Related

- Subchart reference: `charts/ai-platform-engineering/charts/litellm/README.md`
- Endpoint contract: the routing endpoint honours the OpenAI chat-completions
  wire protocol regardless of the real upstream.
