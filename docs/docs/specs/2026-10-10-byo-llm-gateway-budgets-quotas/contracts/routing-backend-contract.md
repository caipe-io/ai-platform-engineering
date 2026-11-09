# Contract ②: Gateway Conformance

Any gateway CAIPE supports must satisfy this contract. It is what keeps gateways swappable.

## Required capabilities

1. **OpenAI-compatible endpoint**: [openai-endpoint.md](./openai-endpoint.md).
2. **Upstream translation**: OpenAI format ↔ the provider's native format (Bedrock, Anthropic, Azure, …).
3. **Identity verification**:
   - `LLM_GATEWAY_AUTH=jwt`: validates the gateway JWT (signature via the issuer's JWKS, `iss`, `aud` = `LLM_GATEWAY_AUDIENCE`, `exp`).
   - `LLM_GATEWAY_AUTH=key`: validates per-agent keys bound to an agent and team in the gateway. Keys may be operator-provisioned; automated key issuance is not required.
   - Rejects missing or forged credentials with 401. JWT expiry leeway `L` must be documented and bounded to 0–60 seconds; reject at or after `exp + L`. Leeway does not excuse an invalid signature, issuer or audience. Expired keys are rejected according to the gateway key policy.
4. **Limits by identity**:
   - JWT auth: enforces limits per `sub`, `agent_id` and `team_id`, namespaced by `org`.
   - Key auth: enforces agent and team limits using the gateway's key bindings. User attribution comes from the request's `user` field and is unverified, so per-user limits are best-effort (FR-005).
5. **Limit rejection**: reject requests when an enforced limit is reached. CAIPE preserves the error status and existing classification; a gateway-specific origin marker, budget scope or reset time is not required.
6. **Fail closed**: if the limit store or rate-limit service is unreachable, requests are rejected, not admitted unmetered.
7. **Error passthrough**: upstream errors keep their class. No silent retry that changes it.
8. **Telemetry**: per-request usage (tokens, cost) is exportable (OTel or Prometheus).
9. **Config as code**: gateway config is declared and applied, never hand-patched.

## Optional capabilities

- **ext_authz** to the BFF CAS adapter (#2909) for call-time model checks.
- **Admin API** for adapter features ([gateway-adapter.md](./gateway-adapter.md)). Without it, use adapter `none`.

## Not required

- HA of the gateway itself (the operator's concern).
- Fallback and retry policy (the gateway's choice).

## Conformance check

A gateway passes for its configured authentication mode when:

- [ ] Every agent path in scope returns a correct completion, streaming and tool calls included.
- [ ] Requests with no credential → 401.
- [ ] Record JWT expiry leeway and test immediately before, at and after `exp + L` with controlled clocks. Do not require acceptance inside the leeway window. Verify the runtime refreshes or fails closed rather than sending an expired cached token.
- [ ] JWT auth: tokens at or after `exp + L` (documented expiry leeway `L` ≤ 60 seconds), wrong-audience tokens and tokens signed by a foreign key → 401; user, agent and team limits each reject the request.
- [ ] JWT auth: an unexpired token with the expected audience and a valid signature from a trusted test key, but an incorrect issuer (`iss`) → 401. Keep all other claims valid to isolate issuer validation; use only test keys and a test gateway configuration.
- [ ] Key auth: invalid or revoked keys → 401; agent and team limits each reject the request. Document whether best-effort per-user limits are supported.
- [ ] Key auth with adapter `none`: an operator-provisioned key stored in CAIPE works without key-issuance capability.
- [ ] An induced upstream 429 or 5xx reaches the agent with its class unchanged, including provider quota errors containing "budget" or "quota".
- [ ] Ambiguous 402/429 responses retain their original classification without inferred scope or budget-increase advice.
- [ ] With adapter `none`, rejections propagate without error-recognition configuration or direct-provider fallback.
- [ ] With the limit store down, requests are rejected (AgentRouter: `quotaRateLimitFailureModeDeny=true`).
- [ ] JWT auth: usage is attributable to verified `sub`, `agent_id` and `team_id`.
- [ ] Key auth: usage is attributable to the key's agent and team; any user attribution is explicitly treated as unverified.
