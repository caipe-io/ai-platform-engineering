# Quickstart: Validate Harness Engine

> **Release scope:** Use [Delivery phases](delivery-phases.md) to select checks. The independent engine/gateway is Phase 1; Deep Agents integration is Phase 2; external workers and cross-harness composition are Phases 3 and 4. Future runbook sections are acceptance criteria, not completed functionality.

## Implemented independent slice

The current code is validated without starting or modifying Dynamic Agents:

```bash
cd ai_platform_engineering/harness_engine
uv sync --all-extras
uv run ruff check src tests
uv run pytest -q

cd ../../../ui
npx eslint \
  src/types/harness-engine.ts \
  src/components/harness-engine/HarnessOptionsForm.tsx \
  src/components/dynamic-agents/DynamicAgentEditor.tsx \
  src/app/api/harness-engine
npx tsc --noEmit
npx jest \
  src/components/dynamic-agents/__tests__/DynamicAgentEditor.platform-default.test.tsx \
  src/app/api/harness-engine/__tests__/routes.test.ts \
  --runInBand
```

Configure at least one operator profile:

```bash
export HARNESS_ENGINE_INTERNAL_TOKEN=local-development-only
export HARNESS_ENGINE_AGENTCORE_RUNTIMES_JSON='{"primary":{"arn":"arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/example"}}'
export HARNESS_ENGINE_CLAUDE_SDK_PROFILES_JSON='{"safe":{"model":"claude-example","cwd":"/workspace","permission_mode":"dontAsk"}}'
uv run uvicorn harness_engine.main:app --host 0.0.0.0 --port 8010
```

The remaining sections are target-architecture release gates and are not claims
about the current experimental adapters.

This is the release-validation runbook for the planned implementation. Commands that reference new test directories become executable as the corresponding phase lands.

## 1. Verify worktree and artifacts

```bash
git branch --show-current
test -f docs/docs/specs/2026-08-17-harness-engine/spec.md
test -f docs/docs/specs/2026-08-17-harness-engine/plan.md
test -f docs/docs/specs/2026-08-17-harness-engine/tasks.md
test -f docs/docs/specs/2026-08-17-harness-engine/contracts/harness-adapter-v1.md
test -f docs/docs/specs/2026-08-17-harness-engine/contracts/canonical-events-v1.md
test -f docs/docs/specs/2026-08-17-harness-engine/contracts/sandbox-worker-v1.md
test -f docs/docs/specs/2026-08-17-harness-engine/contracts/state-memory-tracing-v1.md
test -f docs/docs/specs/2026-08-17-harness-engine/agent-creation-ui.md
```

Expected branch: `2026-08-17-harness-engine`.

## 2. Freeze and replay Dynamic Agents compatibility

Run the unchanged runtime suite first:

```bash
cd ai_platform_engineering/dynamic_agents
uv run ruff check
uv run pytest
```

Then run the new black-box compatibility suite:

```bash
uv run pytest tests/contract tests/conformance -m deepagents
```

Pass criteria:

- No existing test or assertion is removed or weakened.
- Existing OpenAPI paths/schemas match the frozen baseline.
- Golden custom SSE and AG-UI frames match for start, text, reasoning, tools, warnings, nested subagents, interrupts, resume, errors, cancel, and finish.
- Default agents with no `harness` field resolve to `deepagents`.

## 3. Inspect harness catalog

With the service running at the existing address:

```bash
curl -sS http://localhost:8100/api/v1/harnesses
```

Pass criteria:

- `deepagents` is enabled, available, and certified.
- Optional adapters are visible only according to deployment policy.
- Missing dependencies/configuration mark only the affected adapter unavailable.
- No secret values or raw provider failures appear.

## 4. Validate configurations before execution

Send a portable configuration to `/api/v1/harnesses/validate` for each adapter.

Pass criteria:

- Compatible configuration returns `200`, `success: true`, and `valid: true`.
- Incompatible model, middleware, file type, or harness option returns `200`, `valid: false`, and field-specific errors.
- Unknown option/request shape returns `422`.
- Validation performs no model call, tool call, or persistent agent write.
- Attempting to override `harness.id` in a chat request is rejected.

## 5. Run adapter conformance

```bash
cd ai_platform_engineering/dynamic_agents
uv run pytest tests/conformance -m deepagents
uv run pytest tests/conformance -m claude_agent_sdk
uv run pytest tests/conformance -m strands
uv run pytest tests/conformance -m agentcore
```

Each adapter advertised as certified must pass all required cases. An adapter lacking credentials may skip live-provider tests only in ordinary CI; a protected certification job must run them before status changes to certified.

Required cases:

- stream/invoke and usage;
- MCP and built-in tools;
- partial server failure and retry classification;
- form input and tool approval (approve/edit/reject/multiple);
- restart, cross-replica resume, clear, and TTL;
- files and model capability warnings;
- skills and scan gate;
- mixed-harness subagents and nested interrupts;
- cancellation/disconnect at lifecycle boundaries;
- malformed provider events and sanitized errors;
- resource cleanup and credential isolation.

## 6. Verify persistent sessions

For each certified adapter:

1. Start a conversation and send a fact unique to the test fixture.
2. Complete one tool call.
3. Stop the service or force runtime-cache eviction.
4. Start another replica.
5. Continue the same conversation and verify context and tool history.
6. Create a pending input/approval interrupt, repeat the restart, and resume it.
7. Clear the conversation and prove the old native session is no longer used.
8. Kill the worker after partial output but before the final checkpoint commit.
9. Retry with the same idempotency key, then with a different key.

Pass criteria:

- Binding stays on the originating harness and epoch.
- No state appears in another user, agent, conversation, harness, or environment.
- Duplicate resume is idempotent; conflicting resume returns `409`.
- A storage failure is reported as degraded/error, never as successful durability.
- A completed-durable result always references the committed native state head and binding revision.
- An ambiguous post-output failure returns `uncertain_durability`, keeps the previous durable head, and never automatically repeats the tool side effect.
- Restore rejects pending state, wrong binding/owner/epoch/adapter, and stale lease generation.

## 7. Verify agent memory

```bash
cd ai_platform_engineering/dynamic_agents
uv run pytest tests/conformance/test_memory.py tests/integration/test_memory_isolation.py
```

Pass criteria:

- Writable learned memory defaults to the authenticated user+agent namespace and is visible across that user's conversations.
- Another user, agent, organization, environment, sandbox, or native provider session cannot discover or modify it.
- Agent-shared memory requires explicit policy; organization memory is read-only by default.
- Authorization and namespace filtering happen before lexical/vector ranking.
- Every write includes content hash, provenance, writer, source binding/run, approval state, and revision.
- Concurrent writes produce a conflict or declared provenance-preserving merge, never silent last-write-wins.
- Memory injection cannot grant tools, credentials, egress, sandbox settings, or broader memory scope.
- Conversation clear does not silently delete cross-thread memory; explicit memory deletion obeys retention and audit.
- Raw transcripts are not automatically promoted to memory; episodic references remain authorized and bounded.

## 8. Verify distributed tracing

```bash
cd ai_platform_engineering/dynamic_agents
uv run pytest tests/conformance/test_tracing.py tests/integration/test_trace_propagation.py
```

Pass criteria:

- One sampled trace connects request, authn/authz, binding, claim/bind, worker run, provider, thread state, memory, tools, subagents, canonical validation, and stream encoding.
- Malformed/forged incoming `traceparent` is rejected or replaced according to policy.
- Baggage is empty by default and only declared opaque bounded keys can propagate internally.
- Internal trace context is stripped before untrusted external/provider destinations unless explicitly allowed.
- No prompt, message, reasoning, memory body, tool payload, credential, PII, protected skill, checkpoint, environment value, or Kubernetes body appears in telemetry.
- Worker telemetry reaches only the in-cluster collector/control-plane facade.
- Collector outage respects bounded queues, raises health/metrics, and does not change authorization, persistence, cleanup, or run outcome.

## 9. Verify mixed-harness subagents

Create neutral test agents:

- parent on `deepagents`;
- first child on `claude_agent_sdk`;
- second child on `strands`;
- optional third child on `agentcore`.

Run a request that delegates to each child.

Pass criteria:

- Each child gets an independent authorization check and credential scope.
- Events carry correct nested namespaces and stable parent tool-call correlation.
- A child interrupt renders through the existing client contract and resumes the correct child.
- One child/provider failure does not corrupt the parent or siblings.
- Cyclic configuration is rejected before execution.

## 10. Verify security isolation

Run the security suite with at least 1,000 concurrent generated bindings:

```bash
cd ai_platform_engineering/dynamic_agents
uv run pytest tests/integration/test_harness_isolation.py
```

Pass criteria:

- No cross-binding messages, files, native sessions, interrupts, tools, credentials, or traces.
- Authorization denial produces zero adapter/provider calls.
- Provider event payloads cannot inject SSE frames or escape JSON bounds.
- Raw bearer tokens, exchanged secrets, protected skill bodies, and provider stderr do not appear in logs/traces/events.
- Remote session IDs contain no raw email, name, or conversation ID.

## 11. Verify unique sandbox pods

Run the Kubernetes sandbox conformance suite in a cluster with the pinned Agent Sandbox controller and certified RuntimeClasses:

```bash
cd ai_platform_engineering/dynamic_agents
uv run pytest tests/integration/sandbox -m kubernetes
```

Pass criteria:

- Every concurrent local-harness binding resolves to a distinct claim UID, Sandbox UID, and pod UID.
- Follow-up turns reuse only their own healthy lease; another subject/agent/conversation never shares it.
- Worker pods have the expected signed image digest, RuntimeClass, seccomp, non-root user, dropped capabilities, read-only root, resource/PID limits, and no service-account token.
- Default-deny policy blocks Kubernetes API, metadata services, MongoDB, OpenFGA, credential service, unrelated pods, and arbitrary internet destinations.
- User, MCP, cloud, database, and Kubernetes credential canaries do not appear in worker environment, mounts, arguments, files, logs, crash artifacts, or responses.
- Eviction and max-lifetime replacement increment the lease generation; all old-worker events, state writes, resumes, and tool calls are rejected.
- A controller outage affects new claims clearly but does not corrupt ready sessions or provider-managed AgentCore traffic.
- Warm claims become exclusive in under 5 seconds p95, cold claims in under 30 seconds p95, and release destroys the claimed sandbox.

Test at least these fault points:

1. before claim binding;
2. after worker readiness but before `run.started`;
3. during text streaming;
4. before and after a ToolBroker side effect;
5. while interrupted;
6. during state persistence;
7. after terminal event but before lease activity update.

## 12. Benchmark compatibility mode

Run the same deterministic fake-model/tool workload against the pre-change Dynamic Agents baseline and Harness Engine `deepagents` adapter.

Capture:

- first-response p50/p95/p99;
- total-turn p50/p95/p99;
- canonical translation time;
- resident memory at 1, 10, and 20 cached runtimes;
- cleanup duration and leaked tasks/processes/connections.
- tracing overhead with sampling on/off and collector unavailable;
- checkpoint write/head-commit latency and memory read/write latency.

Pass criteria:

- p95 first response and total turn are within 10%.
- event translation is under 25 ms p95 per batch.
- compatibility-only memory growth is at most 20%.
- no resources remain after cache eviction/shutdown.

## 13. Validate UI and BFF

```bash
cd ui
nvm use
npm run lint
npm test -- --runInBand
npm run build
```

Pass criteria:

- Existing editor/chat tests pass unchanged for default agents.
- Legacy documents with no harness render as Deep Agents without being rewritten on open.
- Harness selection precedes model selection; models are filtered by the selected harness and policy.
- Selector cards distinguish certification, availability, and sandbox-pod versus provider-managed execution.
- Every existing section renders native, emulated, unsupported, or unavailable state from the server report.
- Unsupported existing values stay visible as blockers; a harness switch shows a diff and never silently deletes them.
- Switching away and back restores unsaved options for that harness, while the save payload includes only selected-harness options.
- Unknown/unavailable stored harnesses remain inspectable and are never silently coerced to Deep Agents.
- Editing an agent with conversations explains pinning and requires explicit confirmation before changing harness.
- A delayed response for an older draft cannot replace the current catalog/model/validation state.
- The BFF revalidates the exact payload and fingerprint before any MongoDB or OpenFGA write; stale validation returns `409` with fresh field issues.
- Blockers navigate to and focus the first field, are screen-reader announced, and do not rely on color alone.
- Existing `/api/dynamic-agents` response consumers tolerate the additive `harness` field.
- Existing clients need no request change.

## 14. Validate deployment

Render and test Docker Compose/Helm with only `deepagents`, then with each optional adapter enabled.

Pass criteria:

- Existing `dynamic-agents` DNS, port, probes, secrets, metrics, and environment variables remain valid.
- Disabled optional adapters do not import SDKs or affect readiness.
- One unhealthy optional adapter appears unhealthy but does not fail healthy traffic.
- Per-harness capacity rejection carries current retry behavior.
- No adapter SDK secret is placed in a ConfigMap or agent document.
- Harness Engine write RBAC is limited to SandboxClaims in the runtime namespace, with read-only access to bound Sandbox status; worker pods cannot reach the Kubernetes API.
- Agent configuration cannot select arbitrary images, commands, templates, pools, RuntimeClasses, service accounts, volumes, or egress.
- Docker Compose uses the explicit compatibility execution mode and cannot be mistaken for production sandbox certification.

## 15. Rehearse rollout and rollback

1. Deploy Harness Engine with only `deepagents` enabled.
2. Run compatibility smoke and benchmark traffic.
3. Enable one experimental adapter for test agents only.
4. Inject provider failures and verify isolation.
5. Restore the previous Dynamic Agents image without changing DNS or MongoDB.
6. Resume a pre-existing Deep Agents conversation.

Pass criteria:

- Rollback completes within 10 minutes.
- No reverse migration or client reconfiguration occurs.
- Existing Deep Agents conversations resume.
- Non-Deep-Agents conversations are explicitly unavailable/new-conversation-only under rollback; they are never misread as LangGraph state.

## Release evidence

Attach to the release/PR:

- frozen OpenAPI and stream golden diff;
- compatibility matrix with test IDs/status;
- adapter dependency and security reviews;
- conformance reports per exact adapter version;
- performance report;
- isolation/fault-injection report;
- thread durability/ambiguous-crash report;
- memory scope, conflict, provenance, and injection report;
- distributed trace topology, leak scan, overhead, and collector-outage report;
- Helm/Compose validation;
- rollout and rollback timestamps/results.
