# litellm - central LLM routing layer (default-off)

The default central LLM routing layer for CAIPE agents. A **stateless** LiteLLM proxy: every
agent speaks the OpenAI chat-completions protocol to this one endpoint, and the proxy
translates to whichever real upstream the operator selects (OpenAI, Azure, Bedrock, Anthropic).
No database - per-agent keys and spend persistence are not handled here.

## Enable it

This subchart is **default-off**. It renders only when the umbrella flag is set:

```yaml
llmRouting:
  litellm:
    enabled: true
```

That flag is the dependency condition in the parent `Chart.yaml`. The subchart's own
config lives under the `litellm:` key in the umbrella values.

## Configure the upstream provider (once, on the proxy)

The operator supplies the real, cost-bearing provider key via a **proxy-only** secret
(`upstreamSecret`), separate from the agent-facing shared credential - agents never see it.
The proxy reads it via `os.environ/*` refs in `modelList`. Keep provider keys in Secrets, never
in plaintext values.

```yaml
litellm:
  upstreamSecret:
    name: my-llm-provider-secret       # existing / ESO secret with the real upstream key(s),
                                        # e.g. ANTHROPIC_API_KEY, AWS_* creds, AZURE_OPENAI_*
  modelList:
    - model_name: gpt-4o               # what agents request
      litellm_params:
        model: azure/gpt-4o            # the real upstream + native params
        api_base: os.environ/AZURE_OPENAI_ENDPOINT
        api_key: os.environ/AZURE_OPENAI_API_KEY
```

For a dev/values-generated secret instead of a referenced one, set `upstreamSecret.create: true`
and provide `upstreamSecret.data` (never commit real keys). `extraEnvFrom` remains as an escape
hatch for anything beyond `upstreamSecret`.

## Credentials and network posture

- **Shared credential.** Every agent presents one shared key as its `OPENAI_API_KEY`; the
  proxy uses the same value as its `master_key` (read from `LITELLM_MASTER_KEY`, injected from
  the `global.llmSecrets` Secret - key `OPENAI_API_KEY`). Override `masterKeySecret.name` only
  for a proxy-specific secret.
- **Network restriction.** A NetworkPolicy (`networkPolicy.enabled: true`) limits the proxy to
  in-cluster callers so the upstream key it fronts is never reachable off-cluster.

## Behaviour

- **Single instance** (`replicaCount: 1`) for v1; HA is deferred. Routing fails closed - if the
  proxy is down, agent LLM calls error rather than bypassing it.
- **Transparent upstream errors**: `litellmSettings.num_retries: 0` and no fallbacks,
  so upstream 5xx/429/timeout reach the agent unchanged. Do not add retries/fallbacks without
  revisiting that contract.

## Bring-your-own

Leave this subchart disabled and point `global.OPENAI_ENDPOINT` at your own OpenAI-compatible
proxy (which must itself translate to your upstream).
