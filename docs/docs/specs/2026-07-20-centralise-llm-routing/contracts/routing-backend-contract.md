# Contract: Routing Backend

Any routing layer CAIPE supports — the shipped default (LiteLLM) or a bring-your-own
proxy — MUST satisfy this contract. Keeping it explicit is what makes the backend
swappable (Composition over Inheritance) and lets the budget epic add a second backend
without touching agents.

## Required capabilities

1. **OpenAI-compatible endpoint.** Exposes `POST /v1/chat/completions` (and the
   embeddings/models endpoints agents use) speaking the OpenAI wire protocol. This is
   what every agent addresses via `OPENAI_ENDPOINT`.

2. **Upstream translation.** Accepts OpenAI-format requests and translates to the real
   upstream's native protocol — including non-OpenAI-native (Bedrock, Anthropic) — then
   translates the response back (FR-008, SC-007). The "which upstream" choice is central
   config, not per request from the agent.

3. **Credential enforcement.** Rejects unauthenticated requests. In v1 a single shared
   credential is accepted (FR-011); the endpoint MUST NOT serve the upstream provider key
   to unauthenticated callers. (The budget epic swaps the shared credential for per-agent
   keys behind this same contract.)

4. **Transparent error passthrough.** Upstream provider errors (5xx, 429, timeout) are
   surfaced preserving status and semantics, with no silent retry or masking, so an agent
   sees the same error class as a direct call (FR-012).

5. **Config-driven, reproducible.** All routing config (models, upstreams, credential
   references) is declared in the codebase (Helm/compose) and applied, never hand-patched.

## Explicitly NOT required in this slice

- Per-agent identity / attribution, spend metrics, dollar budgets, 429-on-budget — these
  belong to the budget epic and are layered on top of this contract later.
- High availability / multi-replica (v1 single instance, fail-closed).

## Conformance check

A backend passes when, configured per [quickstart.md](../quickstart.md):
- every agent type returns a correct completion through it (SC-002),
- an operator on each of OpenAI / Azure / Bedrock / Anthropic can adopt it (SC-007),
- an unauthenticated request to the endpoint is refused,
- an induced upstream 429/5xx reaches the agent unchanged in class.
