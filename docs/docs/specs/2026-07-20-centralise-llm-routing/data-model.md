# Phase 1 Data Model: Centralise LLM Routing and Provider Selection

This feature has **no persisted data** (stateless routing). The "data model" here is the
**configuration model** — the single source of truth for routing, and how it flows by
inheritance to agents (Constitution: single source of truth; no per-agent duplication).

## Config entities

### 1. Central LLM routing config (umbrella `values.yaml`, `global`)

The one place provider choice lives. Inherited by every agent via the env they already consume.

| Field | Source | Meaning |
|---|---|---|
| `LLM_PROVIDER` | global env | `openai` for all agents — the neutral wire protocol (not "traffic goes to OpenAI"). |
| `OPENAI_ENDPOINT` | global env | URL of the central endpoint. In-stack: the routing proxy Service. BYO: an operator's proxy. |
| shared credential | `global.llmSecrets` (`llm-secret`, key `OPENAI_API_KEY`) | The single credential all agents present (FR-011). |
| `llmRouting.litellm.enabled` | umbrella values | Opt-in flag for the default routing subchart; default `false` (FR-010, FR-005). |

**Validation / rules:**
- When the subchart is enabled, `OPENAI_ENDPOINT` MUST resolve to the proxy Service; when BYO, it MUST be operator-supplied and the subchart disabled.
- No per-agent provider config: agents inherit `global` (single source of truth). A new agent inherits by default (FR-004).
- Reverting = flag off + restore prior `LLM_PROVIDER`/endpoint → direct provider calls, no residue (FR-005).

### 2. Upstream provider config (proxy config, in the subchart)

The real provider(s) the proxy translates to. Selected centrally, not per agent.

| Field | Meaning |
|---|---|
| `model_list` / route map | Maps the model name agents request to the real upstream (openai / azure / bedrock / anthropic) and its native params. |
| upstream provider key | The real, cost-bearing credential — operator-supplied, configured once on the proxy, via the secret framework. Never in source. |
| master/virtual key | The value behind the shared credential agents present (see entity 3). |

### 3. Shared endpoint credential (Secret)

| Field | Meaning |
|---|---|
| storage | One of three strategies: base Helm-generated (`global.llmSecrets.create`), existing secret (`values-existing-secrets.yaml`), or ESO (`values-external-secrets.yaml`). |
| injection | Mounted as each agent's `OPENAI_API_KEY`; never plaintext (Constitution VII). |
| lifecycle | Static for v1; replaced by per-agent virtual keys in the budget epic. |

### 4. Agent (consumer, unchanged)

Each agent already resolves its model through `cnoe_agent_utils.LLMFactory` using the `global`
env above. **No agent code or per-agent chart change** — the unit is routed through the central
control point purely by inherited configuration.

## Config flow (single source of truth → inheritance)

```
umbrella values.yaml (global)                       litellm subchart (when enabled)
  LLM_PROVIDER=openai ──────────┐                      model_list: request-model → upstream
  OPENAI_ENDPOINT ──────────────┼─► every agent env     upstream provider key (secret)
  global.llmSecrets:OPENAI_API_KEY ─► shared cred        master key == shared cred
                                 │
              (BYO: OPENAI_ENDPOINT → external proxy, subchart disabled)
```

No value is duplicated per agent; changing the provider is one edit at `global` / proxy `model_list`
(SC-001).
