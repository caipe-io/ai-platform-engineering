# Contract: OpenAI-Compatible Wire Endpoint (agent ↔ routing layer)

The single protocol every agent speaks to the central endpoint, regardless of the real
upstream. Agents already produce this via `cnoe_agent_utils.LLMFactory` with
`LLM_PROVIDER=openai`; this contract fixes what the endpoint must honour.

## Request

- **Transport:** HTTPS (or in-cluster HTTP behind NetworkPolicy).
- **Path:** `POST /v1/chat/completions` (plus `/v1/models`, `/v1/embeddings` as used).
- **Auth:** `Authorization: Bearer <shared credential>` — the value injected as each
  agent's `OPENAI_API_KEY` (FR-011). Missing/invalid → `401`.
- **Body:** OpenAI chat-completions schema (`model`, `messages`, `stream`, `tools`, …).
  The `model` value maps, in central config, to the real upstream + native params.

## Response

- **Success:** OpenAI chat-completions response schema (streaming SSE when `stream: true`),
  translated back from the real upstream. Agents cannot tell which upstream served it.
- **Upstream error:** original class preserved — `429` stays `429`, `5xx` stays `5xx`,
  timeouts surface as timeouts (FR-012). No proxy-level retry that changes the class.
- **Routing layer down:** the agent's call fails closed with a clear error; no fallback to
  a direct/unrouted provider call (FR-007).

## Invariants

- No agent-side code change to satisfy this contract (FR-003); it is the same protocol the
  `openai` builder already emits.
- Endpoint selection is one central value (`OPENAI_ENDPOINT`); swapping upstream is central
  config, not an agent change (SC-001).
- Behaviour is equivalent to a direct OpenAI-compatible call except for the added hop —
  which is measured and documented, not bounded by a hard SLO (SC-008).
