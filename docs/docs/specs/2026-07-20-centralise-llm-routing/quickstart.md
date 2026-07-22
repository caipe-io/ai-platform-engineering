# Quickstart: Centralise LLM Routing and Provider Selection

Validation scenarios a reviewer can run to confirm the feature from the docs alone
(SC-006). Two deployment shapes: **in-stack default proxy** and **bring-your-own**.

## A. In-stack default routing proxy (Helm)

1. **Enable the subchart (opt-in).** In your values, set the routing subchart flag on
   (default is off) and provide the upstream provider:

   ```yaml
   llmRouting:              # the default routing subchart
     litellm:
       enabled: true
   global:
     env:
       LLM_PROVIDER: openai
       OPENAI_ENDPOINT: http://<release>-litellm:4000/v1   # the proxy Service
     llmSecrets:
       # shared credential agents present as OPENAI_API_KEY (FR-011)
       create: true         # or reference an existing / external secret instead
   ```

   Configure the **real upstream** (the cost-bearing key) once on the proxy via the
   secret framework — never in source.

2. **Deploy** and confirm the proxy is healthy and network-restricted.
   - *Verify:* proxy `/health` OK; a request to `/v1/chat/completions` **without** the
     shared credential returns `401`; the endpoint is not reachable outside the cluster.

3. **Confirm agents route through it.**
   - *Verify:* pick any agent (e.g. GitHub); a completion succeeds and was served via the
     proxy. No agent code or per-agent provider config was changed (FR-003).

4. **Swap the provider centrally.** Change the upstream in the proxy `model_list`
   (e.g. openai → azure → bedrock → anthropic).
   - *Verify:* every agent uses the new provider after one change, no per-agent edits
     (SC-001); Bedrock/Anthropic (non-OpenAI-native) return correct completions via
     translation (SC-007).

5. **Error passthrough.** Induce an upstream `429`/`5xx`.
   - *Verify:* the agent observes the same error class as a direct call (FR-012).

6. **Reversibility.** Set the flag off and restore prior `LLM_PROVIDER`/endpoint.
   - *Verify:* agents return to direct provider calls, no half-configured state (FR-005).

## B. Bring-your-own proxy

1. Leave the routing subchart **disabled**. Point `global.env.OPENAI_ENDPOINT` at your
   existing OpenAI-compatible proxy and set the shared credential to its key.
   - *Verify:* agents route through the external proxy; same conformance checks
     (routing-backend-contract.md) apply.

## C. Local Docker Compose

1. Enable the routing proxy **profile** (opt-in; it is NOT in the default minimal profile).
   Provide upstream key and shared credential via `.env`.
   - *Verify:* `docker compose up` with the profile brings the proxy up; an agent completes
     through it; disabling the profile returns to direct calls.

## Cross-cutting checks

- **All agent types** (GitHub, Jira, ArgoCD, AWS, PagerDuty, Slack, …) via the existing
  integration harness each return a correct completion through the endpoint (SC-002).
- **Latency:** the harness records the added-hop delta for at least one agent and writes it
  into the integration guide (SC-008).
- **First-install safety:** the default minimal OSS profile is unchanged; nothing here is
  on by default (docker-compose first-install gate).
