# Harness Engine

Independent execution control plane for non-Dynamic-Agents harnesses. AgentCore, Claude Agent SDK and opt-in private Claude Code ACP profiles use the same
portable blueprint, durable owner and adapter contract.

## Boundary

- DeepAgents remains the default execution path. Its tools, skills and workflow
  preparation is shared with the coding-provider tool service; ordinary native
  graph construction, logical files, checkpointing and streams retain their behavior.
- Complete agent blueprints and immutable versions are stored separately in
  `harness_agents` and `harness_agent_versions`.
- Durable `harness_sessions` bind an owner, agent version, and conversation to
  one native provider session. Existing conversations remain pinned when an
  agent is edited.
- `CAIPEAgentSessionManager` owns opaque binding IDs, ownership, version pinning,
  epochs, persistence, and clear. Each adapter supplies a narrow
  `ProviderSessionManager` for native open/observe/close behavior.
- Runs and replayable events are stored in `harness_runs` and `harness_events`.
- The same caller/agent/conversation tuple receives the same opaque binding.
  AgentCore derives a stable `runtimeSessionId`; Claude persists the SDK result
  session ID and supplies it through `resume` on the next turn.
- The Next.js BFF authenticates and authorizes callers, then uses an internal service
  credential and the verified subject. Private coding runs renew scoped owner OBO
  tokens server-side for existing CAIPE services; provider credentials never enter
  the sandbox. AgentCore retains its existing IAM boundary.
- A provider invocation belongs to Harness Engine, not to an SSE subscriber. Closing a browser or BFF connection only removes that subscription.
- The existing BFF `/api/v1/chat/*` routes form Harness Gateway. They read the
  BFF-owned `execution_harness_id`, preserve Dynamic Agents for missing/default
  values, and translate Harness Engine canonical events for existing clients.
- The gateway pins each owner/agent/conversation backend in the BFF's
  `harness_gateway_bindings` collection. An agent edit does not change an
  existing conversation's runtime. The authorized session-clear endpoint removes
  that routing record only after Engine clear succeeds.
- On first use, the gateway adopts native checkpoints from the application's
  configured checkpoint collection and Engine sessions from the internal API.
  Conflicting contexts return `409`. Known native context remains usable when
  optional Engine lookup is unavailable. The BFF does not read Engine's private DB.
- Missing Engine configuration returns `503` for saved SDK agents or pinned
  Engine conversations. Legacy/default agents still use Dynamic Agents.

## Agent Builder harness status

- LangChain Deep Agents is the **Stable** default.
- Claude SDK and AgentCore are **Experimental** CAIPE integrations. Agent Builder
  shows the catalog's certification status in the harness dropdown and beside
  the selected harness. `certified` is labeled **Stable**; `blocked` is labeled
  **Blocked** and remains disabled.

## Connect an existing AgentCore deployment

- In **Agent Builder → Execution harness**, a platform administrator chooses
  **Add existing AgentCore agent**, enters a connection ID beginning with `existing-`, a Harness or
  Runtime ARN, its matching AWS Region, and a qualifier.
- Registration saves an immutable `shared` operator profile in
  `harness_agentcore_profiles`. MongoDB preserves it across restarts; the
  development memory backend does not. Identical retries reuse the connection;
  an existing ID cannot be pointed at a different target.
- The current Builder selects AgentCore and the connection, preserving the
  draft's instructions, owner-team and sharing choices. Save the agent to apply it.
  The connection also remains available in the operator profile picker.
- Registration checks ARN syntax and Region consistency. The Engine uses its
  existing AWS credentials; IAM invocation permission is checked when chatting.
  Registering does not discover AWS resources or import configuration/history.
- Managed Harness calls use CAIPE instructions. Custom Runtimes must accept
  the adapter's request/response contract. Native provider tools keep their AWS
  permissions; CAIPE tool grants do not automatically constrain them.
- Registration requires both `admin_ui#admin` and CAS management permission on
  `system_config:platform` in the BFF. The internal endpoint additionally
  requires the service credential and an admin marker set only by that route.
  The normal catalog exposes profile aliases, never ARNs or credentials.
- Connections extend the operator allowlist for agent builders. Chat/run access
  still requires current CAIPE agent and conversation permissions. Each caller,
  agent and conversation keeps its own Engine binding/provider session.
- Shared connections never create, update or delete the AWS deployment. Removing
  a CAIPE agent removes its CAIPE records; the imported target remains external.

## App-owned chat streams

- The BFF's start, resume, cancel and status routes share one dispatcher after
  agent-use and conversation-write authorization.
- Installed apps use their server-declared assistant paths through the shared
  app proxy, preserving the resolved caller and canonical conversation ID.
  App errors, denials and unsupported operations return directly.
- Other start/resume/cancel requests resolve their runtime conversation ID and
  pinned Harness Gateway backend. Provider dispatch does not require the
  Dynamic Agents service configuration.
- App-owned assistants require streaming; non-streaming invoke returns `501`
  before creating a native/provider binding. Status is available only when an
  app declares it, with `501` for unsupported runtimes.
- Host chat panels, overlays and cross-window app status use the existing
  shared UI/store contracts. Provider runs retain Engine-owned detached
  execution and replay; app streams keep their app-owned session lifecycle.

## Authorization boundary

- The BFF checks current agent use and conversation write before execution,
  resume, Stop or clear. A saved agent participant must match the requested
  agent; an authorized request cannot substitute another agent's runtime.
- Direct Engine admission also verifies the pinned gateway target is a
  provider runtime, preserving native session ownership.
- Run detail, polling and replay subscriptions retain Engine owner checks and
  recheck current agent use plus conversation read in the BFF. Cancellation by
  run ID requires conversation write. Keeping a run ID does not retain revoked
  access.
- Service accounts retain their principal classification in platform checks.
  Engine uses internal credentials plus the verified caller subject; app-owned
  streams use the exact authenticated interactive user.
- Grants are checked per request/subscription. Existing streams are not
  continuously reauthorized; downstream app/tool resource checks remain
  authoritative for their own operations.

## Session flow

```mermaid
sequenceDiagram
    participant Browser
    participant BFF
    participant HE as Harness Engine
    participant MongoDB
    participant AC as AgentCore Runtime

    Browser->>BFF: POST /api/v1/chat/stream/start
    Note over BFF: Resolve pinned backend or adopt the saved session
    BFF->>HE: POST /api/v1/runs (internal token + subject)
    HE->>MongoDB: resolve binding + reserve queued run
    HE-->>BFF: 202 run_id
    HE->>AC: invoke/resume native session
    AC-->>HE: streaming chunks
    HE->>MongoDB: append sequenced events
    Browser->>BFF: GET events/stream?after=N
    BFF->>HE: subscribe after N
    HE-->>Browser: replay + live SSE
    Browser--xBFF: disconnect
    Note over HE,AC: invocation continues
    Browser->>BFF: reconnect with Last-Event-ID
    BFF->>HE: subscribe after last event
    HE-->>Browser: remaining replay + live SSE
```

Web UI, Slack, and Webex use the same gateway routes and AG-UI contract. They
do not load provider SDKs or implement harness-specific routing. Current
non-default adapters support start, detached execution, replay, invoke, and
active-run cancellation. Legacy SDK adapters retain their existing human-input/attachment limitations.
Private Claude Code ACP profiles implement the negotiated human-input and opaque
attachment contracts described below.

CAIPE CLI `0.2.24` also uses the AG-UI gateway contract. Harness Gateway emits
camel-case `toolCallId` fields expected by that release and carries its optional
per-turn `context` into the provider system prompt without modifying the saved
agent blueprint. The additive accessible-agents response includes `harness_id`
and `harness_name` for newer CLIs. Those clients retain `X-Harness-Run-ID` and
the SSE cursor so a dropped connection resumes the detached run through the
canonical replay endpoint without resubmitting the prompt.

The BFF remains horizontally stateless. Harness Engine is session-aware through
durable bindings and owns each provider task after returning `202`. `run_id`, an
event cursor, MongoDB, and the provider session ID form the reconnect contract.
This avoids sticky BFF sessions and keeps execution alive when a browser or BFF
subscriber disconnects. Process-failure takeover of an in-flight provider call
is not implemented yet; completed event replay and subsequent thread resume are.

## Admission and replay guarantees

- Each binding has one durable run reservation. Reserve before compiling the
  prompt; a distinct overlapping request returns `409`.
- Stop persists a cancellation request that the owning producer observes across
  replicas. A dispatched provider drains with further content suppressed before
  releasing its reservation. `cancelled: false, cancellation_requested: true`
  means stop is pending; a request handled by another replica cannot free the slot.
- `client_request_id` is scoped to owner, agent and conversation. Identical
  retries return the original run; reusing a key with different input returns
  `409`, including after completion.
- Clear closes the durable binding before provider cleanup. Dispatch uses a
  conditional write against the active reservation, so a start paused during
  compilation cannot invoke the provider after a successful clear.
- MongoDB publishes each event's payload, sequence and run status in one run
  document update. Appenders and readers idempotently copy the pending event
  into `harness_events`, recovering an interruption between the two writes.
- Missing or expired replay tails return `409` with `replay_unavailable` before
  subscription. A gap discovered on an open SSE stream emits `run.failed` with
  that code and closes the stream.
- Nonstreaming invoke consumes events through the committed terminal sequence
  before returning or persisting the response.
- A lost producer still requires an explicit clear; provider takeover after
  process failure remains outside this implementation.

## Portable contract

- `AgentBlueprint` owns portable prompt, model, tool, thread, memory, workspace,
  streaming, delegation, and run-limit policy.
- `HarnessDescriptor` advertises sanitized operator profiles, a bounded JSON
  Schema, and `native`/`emulated`/`unsupported`/`unavailable` capabilities.
- `HarnessRegistry` validates and normalizes a draft, returns a catalog revision
  and configuration fingerprint, then resolves the selected adapter at run time.
- Adapters receive `RunContext` and emit canonical events only.
- Adapters expose a provider-specific session manager; they do not persist or
  derive CAIPE binding ownership themselves.
- Broker protocols isolate thread state, memory, tools, sandboxes, prompts,
  delegation, and telemetry from SDK-specific code.

See [Portable abstractions](../../docs/docs/specs/2026-08-17-harness-engine/portable-abstractions.md)
for the full contract, UI flow, persistence model, and sandbox target architecture.

## Configuration

Harness Engine variables use the `HARNESS_ENGINE_` prefix:

- `HARNESS_ENGINE_INTERNAL_TOKEN`: required BFF-to-engine credential.
- `HARNESS_ENGINE_STORAGE_BACKEND`: `mongodb` for durable/replayable production sessions; `memory` for tests and local development.
- `HARNESS_ENGINE_MONGODB_URI` and `HARNESS_ENGINE_MONGODB_DATABASE`.
- `HARNESS_ENGINE_AGENTCORE_RUNTIMES_JSON`: sanitized AgentCore profile map.
  - Backward-compatible shared target: `{"primary":{"provisioning":"shared","arn":"arn:aws:bedrock-agentcore:us-east-1:111122223333:harness/example-AbCdEf1234","qualifier":"DEFAULT","region":"us-east-1"}}`.
  - One AWS Harness per CAIPE agent: `{"primary":{"provisioning":"per_agent","execution_role_arn":"arn:aws:iam::111122223333:role/example-agentcore-role","region":"us-east-1","model_id":"global.anthropic.claude-sonnet-example"}}`.
  In `per_agent` mode, Harness Engine creates and deletes the AWS Harness and
  stores its ARN and provider-configuration fingerprint in the private
  `harness_provider_resources` collection. Provider-relevant edits update the
  same AWS Harness in place. Agent blueprints and browser responses contain
  only the profile ID.
- `HARNESS_ENGINE_AGENTCORE_PROVISION_TIMEOUT_SECONDS` and
  `HARNESS_ENGINE_AGENTCORE_PROVISION_POLL_SECONDS`: readiness polling bounds
  for per-agent Harness creation.

The workload policy for `per_agent` profiles must include the Harness actions
and their documented AgentCore dependencies: runtime/runtime-endpoint, memory,
and workload-identity create/update/delete permissions in the configured
account and Region. `iam:PassRole` must be restricted to the profile's execution
role and `bedrock-agentcore.amazonaws.com`.

Minimum lifecycle action groups:

- create: `CreateHarness`, `CreateHarnessEndpoint`, `CreateAgentRuntime`,
  `CreateAgentRuntimeEndpoint`, `CreateMemory`, `CreateWorkloadIdentity`, and
  `TagResource`;
- update: `UpdateHarness`, `UpdateHarnessEndpoint`, `UpdateAgentRuntime`,
  `UpdateAgentRuntimeEndpoint`, and `UpdateMemory`;
- inspect: `GetHarness`, `GetAgentRuntime`, `GetAgentRuntimeEndpoint`,
  `GetMemory`, and `GetWorkloadIdentity`;
- delete: `DeleteHarness`, `DeleteHarnessEndpoint`, `DeleteAgentRuntime`,
  `DeleteAgentRuntimeEndpoint`, `DeleteMemory`, and `DeleteWorkloadIdentity`.

Creation permissions use `Resource: *` with an `aws:RequestedRegion`
condition because the provider resources do not exist yet. Existing-resource
actions should be restricted to the deployment account/Region Harness,
runtime, memory, and default workload-identity directory ARN patterns.
- `HARNESS_ENGINE_CLAUDE_SDK_PROFILES_JSON`: alias-to-operator-owned Claude
  policy, for example `{"safe":{"model":"claude-example","cwd":"/workspace","permission_mode":"dontAsk"}}`.
- `HARNESS_ENGINE_EVENT_RETENTION_SECONDS`: TTL for replay events.

With the MongoDB backend, the Claude adapter mirrors the SDK's provider
transcript into `claude_session_transcripts`. CAIPE stores the opaque Claude
session ID in `harness_sessions`; the transcript is the other half of the
resume contract. Keeping both in shared storage lets another Harness Engine
replica resume the thread without depending on a container's local
`~/.claude` directory. The SDK's local working copy lives under `/tmp` and is
disposable.

The UI BFF requires:

- `HARNESS_ENGINE_URL`, for example `http://harness-engine:8010`.
- `HARNESS_ENGINE_INTERNAL_TOKEN`, matching the service value.

Run locally:

```bash
uv sync --all-extras
uv run uvicorn harness_engine.main:app --host 0.0.0.0 --port 8010
```

Quality gates:

```bash
uv run ruff check src tests
uv run pytest -q
```


## Private Claude Code over ACP

Claude Code is an opt-in Engine provider (`claude_code_acp`), not a replacement
for the default DeepAgents runtime. No existing SRE deployment is switched by
installing this source. Agent authors select an operator-approved private
profile; ordinary CAIPE chat, tools and specialist selections remain the entrypoint.

```mermaid
flowchart LR
  Client[CAIPE UI, API or integration] --> Gateway[Existing Harness Gateway]
  Gateway -->|Default| Deep[Existing DeepAgents runtime]
  Gateway -->|Selected coding profile| Engine[Existing Harness Engine owner]
  Engine -->|ACP v1| Claude[Private Claude Code environment]
  Claude -->|Run-scoped MCP and Git capabilities| Resources[Existing CAIPE tools and specialist dispatcher]
  Deep --> DB[(One canonical CAIPE MongoDB)]
  Engine --> DB
  Resources --> DB
  Engine -->|Verified native state and approved artifacts| DB
```

| Concern | Coding-provider behavior |
|---|---|
| Execution owner | Existing Engine run reservation, renewable producer fence and canonical event journal. No second native coordinator or execution journal. |
| Instructions | The admitted version's prompt is rendered through the existing platform compiler; accepted request context is appended separately. Skills become managed Claude skill files. |
| Tools and specialists | Current CAIPE selections, credential exchange, datasource filtering, workflow tools and private native specialist contexts are reused through the authenticated platform resource boundary. |
| Human input | The pending request and exact decision live on the existing run. A decision releases the original ACP callback and never starts another prompt. Offered permission choices and CAIPE approval rules are independently validated. |
| Visible history | New coding turns register deterministic canonical user/assistant rows before dispatch. The browser adopts those IDs and hands persistence to the server. The committed Engine journal projects final output; a durable projection outbox retries storage outages. Existing SDK/native writers keep their current ownership. |
| Browser disconnect | Drops only the event subscriber. Run status, replay, decisions and Stop use the retained owner/agent/conversation binding. Ambiguous admission failures reconcile status without resubmitting a prompt. |
| Process or connection loss | An unacknowledged turn becomes interrupted. There is no automatic prompt replay or producer takeover; external effects can be uncertain. Clear creates a new epoch. |
| Native state | Quiescent provider-native archives are verified and stored in canonical MongoDB GridFS. One fenced pointer on the existing session publishes the acknowledged checkpoint. Cache loss restores that exact checkpoint before strict ACP session loading. |
| Workspace | The agent has real filesystem/network access inside its approved environment. The UI exposes bounded approved artifacts from an acknowledged checkpoint, including integrity-checked binary downloads. Direct UI edits/deletes are explicit unsupported capabilities; they do not fall back to DeepAgents files. |
| Storage | Engine collections, projection outbox, attachments, opaque provider state and artifact bytes share CAIPE's configured database/backup boundary. The sandbox filesystem is an execution cache. |

A canonical visible conversation is validated against its saved participant and
runtime pointer. Autonomous aliases require a stored `execution_context_id` or
an owned task's latest run mapping. An arbitrary caller-supplied alias cannot
attach another execution's history. Journal-only API invocations do not invent
UI conversations; their existing publisher remains authoritative. A workflow
using the existing CAIPE workflow tools is distinct from qualifying a workflow
engine to invoke a new provider.

### Operator configuration

The new provider is unavailable with the in-memory repository or incomplete
operator settings. It never makes an unqualified profile the platform default.

| Variable | Purpose |
|---|---|
| `HARNESS_ENGINE_CLAUDE_CODE_PROFILES_JSON` | Profile alias to pinned sandbox profile/revision, model/turn policy and optional Git policy. |
| `HARNESS_ENGINE_CODING_SANDBOX_SERVICE_URL` | Approved provisioning, ACP transport, workspace and native-state endpoint. Agent drafts cannot supply URLs, commands, images or credentials. |
| `HARNESS_ENGINE_CODING_RESOURCES_URL` | Existing Dynamic Agents service exposing `/api/v1/harness-resources` under a verified owner JWT and exact Engine producer fence. |
| `HARNESS_ENGINE_CODING_PLATFORM_URL` | Existing CAIPE BFF/CAS and credential-service base. |
| `HARNESS_ENGINE_CODING_TOOLS_PUBLIC_URL` | Engine base reachable from the approved environment for run-scoped MCP/Git callbacks. |
| `HARNESS_ENGINE_CODING_OBO_TOKEN_URL`, `...CLIENT_ID`, `...CLIENT_SECRET`, `...AUDIENCE` | Dedicated operator-scoped RFC 8693 client. Renewal uses only a server-admitted run, repeats current CAS authorization and stops after revocation, cancellation or lease loss. |
| `MONGODB_URI`, `MONGODB_DATABASE` | The canonical CAIPE store. Separate Engine coordinates are rejected when they conflict with these settings. |

Example operator profile (IDs and destinations are deployment-owned):

```json
{
  "private-primary": {
    "sandbox_profile_id": "private-primary",
    "revision": "qualified-revision",
    "model": "approved-model",
    "max_turns": 100,
    "permission_mode": "default",
    "git": {
      "repositories": ["example/*"],
      "read_tool_ids": ["github-server.get_file_contents"],
      "write_tool_ids": ["github-server.push_files"],
      "ref_prefixes": ["refs/heads/agent/"],
      "audit_service_url": "http://audit-service:8010"
    }
  }
}
```

A remote profile must satisfy the released bounded native-state contract and
negotiated MCP, attachment and skill capabilities. Pinned profile revisions and
connection identity cannot change silently for an existing session.

### Policies and Git

Policy does not depend on whether the caller uses the UI, an API or a chat
integration. The platform resource boundary repeats current agent/tool
permissions, validates immutable claimed tool arguments, and enforces mandatory
CAIPE approvals before effects. Safe tool retries reuse existing middleware and
require trusted read-only/idempotent annotations. An uncertain claimed effect
is never replayed. Per-run call/turn budgets remain bounded.

Claude applies inference retry counts and native context compaction. Custom
DeepAgents retry classifiers/delays or context-editing parameters with no exact
mapping are rejected. Required PII/DLP or other unmapped policies are rejected
before prompt, skills or tool resources cross the boundary. ACP permission
notifications do not substitute for a mandatory CAIPE approval.

When an approved Git policy is selected, HTTPS GitHub remotes use a host-bound
credential helper and repository-scoped run capabilities. The Engine refreshes
the caller's existing connected GitHub account through CAIPE's credential
service. Its token stays server-side. Each operation intersects operator
repository/ref rules, selected Git tool actions, CAS permissions and current
GitHub repository permissions. Default/protected branch writes are blocked
unless explicitly admitted. Bounded pack verification rejects forced ancestry
rewrites before forwarding a push. Git writes use durable human review and one
atomic dispatch claim; an accepted uncertain write is reconciled by reading
exact remote refs, never by sending the pack again. Reads, writes, cancellation
and cleanup use the existing audit service.

A basic coding profile without Git policy does not claim authenticated Git CLI
capability. A whole-agent SRE migration requires qualification with its actual
tools, specialists, policies, model, Git account, network limits and private
profile; an empty generic profile is not evidence of parity.

See [the metaharness proposal](https://github.com/orgs/caipe-io/discussions/2877)
and [the merged gateway foundation](https://github.com/caipe-io/ai-platform-engineering/pull/2401).
