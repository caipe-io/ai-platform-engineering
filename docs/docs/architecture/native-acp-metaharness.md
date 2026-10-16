---
sidebar_position: 9
---

# ACP metaharness

CAIPE owns agent definitions, execution admission, conversation history and the
workflow engine. ACP connects that platform to the runtime executing an agent.
A logical DeepAgents agent and a sandboxed CLI harness use the same CAIPE chat,
run journal and human-input lifecycle; their native state remains different.

The initial phase of the [metaharness proposal](https://github.com/orgs/caipe-io/discussions/2877)
established the native ACP path and detached execution. The current changes add
Claude Code sandbox profiles, remote ACP transport, a platform tool/workspace
bridge and canonical native-state checkpoints.
**These additions are under review. Remote deployment, provider authentication,
network policy and complete skills qualification remain pending approval.**
This document does not imply that a deployed agent has changed runtimes.

## What changes with runtime placement

| Area | Native foundation | Sandbox integration under review |
|---|---|---|
| Execution | Existing DeepAgents/LangGraph runtime behind a logical ACP agent. Default, SRE and custom agents remain shared logical agents. | A configured Claude Code ACP process in a provider-managed environment. Codex is deferred until its persistence integration is qualified. |
| Agent definition | Native model, prompt, tools and skills use existing configuration. | `execution.kind=sandbox` selects a configured `profile_id`; its deployment owns image, command, model route and credentials. |
| Files | Existing simulated filesystem and checkpoint/GridFS storage. | A real workspace restored from canonical native-state checkpoints, plus bounded text and binary artifact exchange with CAIPE's existing file store. |
| Session | Original LangGraph thread and admitted storage coordinates. | Pinned environment identity and native provider session ID, stored in the same CAIPE binding. |
| Platform services | Native tools, human input, subagents and the existing workflow engine. | A run-scoped tool broker reuses those services without giving the harness the caller's bearer. |

A sandbox is an execution choice, not an ACP enablement flag. Existing agents
remain native by default. A saved conversation retains its first execution and
storage binding even when its agent definition later changes placement.

Bedrock AgentCore or another SDK runtime still needs its own qualified adapter.
A shared SDK adapter must preserve CAIPE's simulated filesystem; an SDK working
directory does not supply that contract. This integration does not add OpenShell
or another sandbox implementation, cross-environment discovery, or arbitrary
remote endpoint registration.

## One execution service, two placements

```mermaid
flowchart TB
  Clients[Browser, bots and automation] --> Routes[Existing CAIPE APIs]
  Routes --> Runs[Run coordinator and cursor replay]
  Runs --> Execution[Agent execution service]
  Runs --> DB[(Canonical MongoDB)]
  Execution --> Binding[Admitted agent and session binding]
  Binding --> Native[Logical ACP agent]
  Native --> Deep[DeepAgents and LangGraph]
  Binding --> Remote[ACP client and transport]
  Remote --> Provider[Configured sandbox provider]
  Provider --> Harness[Claude Code harness]
  Harness -->|Run capability| Broker[CAIPE platform tool broker]
  Broker --> Tools[Current tools, workflows and native children]
  Deep --> DB
  Execution --> DB
  Broker --> DB
  Harness --> Workspace[Native working filesystem]
  Workspace -->|Quiescent checkpoint| Checkpoints[Versioned native-state archive]
  Checkpoints -->|Verified bytes and fenced head| DB
  DB -->|Restore committed state before load| Workspace
  Workspace -->|Bounded file artifacts| Files[Existing CAIPE file store]
  Files --> DB
```

The execution service owns leases, binding resolution, runtime lifetime and
state operations. HTTP routes retain authentication, authorization and request
validation. Selecting a sandbox does not create a second conversation writer,
workflow engine or authorization system.

| Protocol boundary | Behavior |
|---|---|
| CAIPE clients | Existing AG-UI/custom SSE and invoke contracts; stable turn IDs and sequenced reconnect. |
| Native ACP | Released Python SDK `0.12.1`, wire protocol `1`; acknowledged `caipe.io/native-acp` events preserve existing native progress and checkpointed approvals. |
| External ACP | The same pinned SDK and wire protocol, standard initialization, new/load, prompt, updates, permission requests and cancellation. A saved native session must load successfully; failure never falls back to a fresh conversation. |
| Form elicitation | A narrow validated shim covers newer schema form messages missing from the SDK callback surface. It accepts session-bound supported fields/choices and bounded decisions; URL elicitation and unsupported schemas are rejected. It does not enable the unstable protocol. |
| Transport | One bounded JSON-RPC object per non-TTY WebSocket message. Stderr and lifecycle controls are separate from ACP. Redirects cannot forward the caller's bearer to another destination. |

Typed events remain the internal boundary. The ACP client renders progress
through existing encoders, including separate reasoning, tools, warnings and
human-input events. It does not infer execution state by parsing UI text.
Native client filesystem/terminal capabilities remain unadvertised; CLI
harnesses operate their own sandbox filesystem and native tools.

The [Harness Engine discussion](https://github.com/orgs/caipe-io/discussions/2405)
and [gateway implementation](https://github.com/caipe-io/ai-platform-engineering/pull/2401)
provide related session, configuration UI and detached-run foundations. This
implementation keeps those concerns behind one CAIPE execution service and ACP
boundary. Provider-specific state is bound to canonical sessions rather than
introducing another routing engine or conversation database.

## Sessions and persistence

| State | Authority and location |
|---|---|
| Conversation and visible history | Existing CAIPE conversation/BFF APIs in canonical MongoDB. The browser remains the interactive transcript writer. |
| Effective configuration and placement | `native_acp_sessions`: original agent/session identity, configuration snapshot and immutable checkpoint/filesystem or sandbox binding. |
| Native runtime state | Existing LangGraph checkpoint collections and logical file namespace. ACP does not rename the original thread. |
| Claude Code runtime state | Opaque versioned HOME/workspace archives in canonical MongoDB GridFS, with manifests in `native_acp_checkpoints`. The provider filesystem is the working copy. |
| Active execution and checkpoint head | `native_acp_runs` owns the native lease, checkpoint publication fence and recovery intent; `native_acp_execution_runs` owns turn identity, producer association, outcome and pending human decisions. |
| Replay | `native_acp_execution_events` stores sequenced output; subscribers do not own or restart execution. |
| Platform tool calls | `native_acp_tool_requests` stores bounded, idempotent requests and results under the owning run/lease. Only the producer holding that lease executes them. |

### Canonical storage without replacing the native harness

Claude Code continues to use its native files while running. CAIPE checkpoints
those files into the same MongoDB database as conversation and execution records;
a provider volume is a working cache rather than the only recoverable copy.
This preserves native transcripts, sub-agent state, compaction, file history,
settings, binary workspace files and local database/WAL files without translating
them into CAIPE chat messages. It does not require an experimental external
session-store API or change the harness's native file checkpointing.

| Boundary | Guarantee |
|---|---|
| Successful turn | CAIPE closes and drains the ACP process, validates the complete archive and persisted hash, then publishes the checkpoint head under the existing live lease before emitting success. A storage failure cannot become a successful completed turn. |
| Next turn | Restore the committed head before native `session/load`, including on a healthy volume. Uncommitted working files cannot silently replace canonical state. Each hydration uses a new restore identity. |
| Lost allocation | A committed checkpoint permits owner-bound replacement, verified restore and lease-fenced allocation rebinding. Caller, profile/runtime versions and native session ID stay pinned. No checkpoint means no fabricated recovery. |
| Stop or graceful failure | Attempt a bounded quiescent checkpoint while the same worker still owns the lease. If capture fails, retain the previous committed head and report the failure. |
| First prompt | Keep the new live native session open until its first settled prompt can be checkpointed. Before that first checkpoint, the journal is durable but total working-storage loss can lose unfinished native state. |
| Hard worker loss | Retain canonical output and the last committed native checkpoint; report interruption. Do not repeat prompts, tools or approval callbacks to reconstruct a response. |
| Upgrade | Require the admitted profile and native adapter/SDK versions. Format or runtime changes need a qualified migration; a matching visible transcript is insufficient. |

The checkpoint is an opaque, bounded archive, not a second conversation service.
Uploads remain unpublished until fully validated. The checkpoint head shares the
existing lease document so an expired worker cannot overwrite a newer owner's
state. Replacement recovery records its intent before provisioning, then makes
the destination executable only after the verified restore receipt and fenced
binding update. Interrupted restores block execution until recovery completes.

Archives include the managed workspace manifest so revoked skills and inputs can
be removed correctly. Fixed exclusions omit runtime locks, checkpoint scratch
files and known native login credential files. Credentials are supplied again by
the deployment. Workspace content can still contain secrets produced by tools;
apply the same access, encryption and backup controls as other sensitive CAIPE
records. Active snapshots retain three recent recovery versions plus restore
provenance. Turn boundaries also pin the native states needed to edit retained
conversation history, so their storage grows with that history;
clear/delete removes live checkpoint records and blobs, with bounded orphan
cleanup for interrupted uploads. Backup expiry remains an operator policy.

The initial archive contract allows 256 MiB of archive and expanded state,
128 MiB per file and 20,000 entries. Oversized or inconsistent native state
fails checkpointing explicitly. Capacity planning must include the whole working
HOME, including repository metadata and native session history, rather than only
the text artifacts displayed in CAIPE.

Admission acquires the native lease before reading or changing runtime state.
The 120-second lease is extended with one-second heartbeat/cancellation polling;
workers require synchronized clocks. New turns refresh permitted configuration
while retaining admitted storage and placement. Human-input resume uses its
saved configuration narrowed by current grants.

A sandbox binding additionally pins the original caller, configured connection,
profile revision, namespace, environment UID, cwd and provider session ID.
Changing a profile/image/policy or failing native session load requires explicit
migration or a new conversation. Losing an environment can recover the same
native session from its committed checkpoint under the pinned profile. Existing native checkpoints
are not imported into a different harness as if they were that harness's state.

```mermaid
sequenceDiagram
  participant UI as CAIPE client
  participant Service as CAIPE run owner
  participant DB as Canonical MongoDB
  participant Agent as Admitted runtime
  UI->>Service: Start with stable turn identity
  Service->>DB: Reserve turn and execution binding
  Service->>Agent: Prompt the same native session
  loop Progress
    Agent->>Service: ACP event or platform tool request
    Service->>DB: Persist before publishing cursor
    Service-->>UI: Existing UI event and cursor
  end
  Note over UI,Service: A disconnected subscriber does not cancel work
  UI->>Service: Subscribe after last consumed sequence
  Service->>DB: Read retained events and outcome
  Service-->>UI: Replay without repeating prompt or tools
```

Worker loss retains persisted output and the last committed native state but
reports interruption.
Neither the lease nor the journal provides exactly-once effects at an external
service. A claimed platform tool request is not reclaimed after uncertain
failure. Recovery must never repeat a prompt or mutation merely to reconstruct
its response.

## Platform tools, children and human input

The sandbox receives a random run capability for one configured CAIPE MCP
endpoint. Caller bearers and connected-provider credentials remain in the
producer's server-side tool closures. Any API replica may authenticate the
capability and queue a call; only the admitted producer executes it.

- Tool discovery reuses native resource preparation. Each call rechecks current
  agent use, tool configuration and resource admission; a configuration change
  can narrow a running session rather than redirect its pinned workspace.
- Native built-ins, selected MCP/remote tools, workflow tools and configured
  skills retain their existing service owners. The workflow engine is unchanged.
- A configured native child receives its own canonical execution context and
  lease. Delegation rechecks the reference, agent use and evidence boundary,
  including after human pauses; a child cannot reuse its parent's run capability
  or introduce a second sandbox through an unqualified nested execution path.
- Native child/tool approvals, ACP permission requests and supported forms use
  the existing CAIPE UI. The durable pending request validates the actual
  displayed options/schema; model-authored values cannot become human approval.
- Reply submission is idempotent and resumes the waiting producer. It does not
  launch another prompt. Explicit cancellation resolves pending callbacks and
  stops the admitted execution; closing a browser or tool HTTP observer does not.

ACP capability negotiation is not an authorization grant. Existing CAIPE caller,
conversation, workflow and tool authorization still applies. Restricted evidence
and storage aliases must pass execution/workspace admission before they can
cross into an external runtime.

## Workspace and filesystem policy

Native DeepAgents keeps its simulated filesystem. Real CLI execution requires
a separate environment with persistent storage and enforced filesystem/network
policy. ACP itself supplies neither isolation nor egress enforcement.

| Workspace operation | Contract and limit |
|---|---|
| Prepare instructions/skills | One managed snapshot containing `AGENTS.md`, `CLAUDE.md`, `.agents/skills/<id>/...` or `.claude/skills/<id>/...`; the profile selects the harness. |
| Seed workflow files | Permission-checked canonical text and binary files become `inputs/<safe relative path>` in the same prepare call. Shared workflow namespaces require the current canonical run/step/owner; arbitrary namespace overrides are rejected. |
| Prepare bounds | At most 128 files, 1 MiB total and 256 KiB per file. The persistent workspace lock prevents preparation during an active ACP process; stale managed files are removed. |
| Read/list | Bounded regular files, excluding private metadata, credentials, symlinks, hardlinks and special files. Provider listing is bounded at 1,000 results/4,096 visited entries; content at 512 KiB. |
| Publish artifacts | Copy bounded text and binary artifacts into the existing canonical file namespace; do not publish instructions, skills, inputs, credentials or native provider state. Export limits/warnings are explicit rather than claiming all files were copied. |
| Edit/upload/format | A fixed-cwd atomic ordinary-file writer accepts at most 512 KiB. Existing text-only `format_file` imports its requested workspace input and mirrors newly formatted results back. No arbitrary HOME, credential or instruction-metadata writes are exposed. |

The bridge bounds canonical input snapshots and output export independently of
the provider limits. Missing, unsupported or oversized artifacts return an error
or visible warning. They are not silently represented as complete exports.
Reads and ordinary-file writes can operate during ACP execution; instruction
preparation remains exclusive.

Binary transfer uses strict base64, decoded byte counts and SHA-256 receipts.
The existing canonical GridFS file record carries `encoding=base64`; the same
file APIs and downloads preserve those bytes. No separate file store is added.
Text previews and `format_file` continue to handle text only.

Interactive files outside the input-copy budget remain downloadable and produce
a visible omission warning; they cannot block every later turn. The committed
native workspace still restores normally. Required shared workflow inputs fail
explicitly when they exceed the input contract.

The provider must validate CAIPE bearer admission independently, pin configured
image/command/policy revisions, isolate users and session workspaces, and check
actual environment/Pod identity plus administrative controls. Agent definitions
cannot supply executable commands, credentials, images or control-plane URLs.
Before a prompt starts, a verified caller obtains a run-bound capture grant.
Only its hash is kept by the environment service. It can authorize bounded
workspace exchange and native-state export until the admitted execution deadline
plus a short capture grace period, including after the login token expires.
It cannot provision, restore, start ACP or perform lifecycle operations. The
client revokes it after capture; rotation, expiry, profile/policy changes and
environment replacement also invalidate it. Neither the grant nor the caller's
bearer is given to the agent.
Admitted long-running execution must not depend on a browser cookie or end
solely because its handshake bearer expires. Reconnect requires fresh admission;
operator execution deadlines and revocation controls still apply.

Model credentials are deployment-owned references, never returned through the
provisioning API. A real CLI may receive its scoped model credential; that is not
out-of-process credential isolation. Use a scoped model gateway and budgets.
The Linux supervisor also adopts and stops detached descendants. Container
policy remains the security boundary against deliberately hostile same-UID code.
Filesystem, egress, model routing and lifecycle guarantees need qualification in
the selected provider, not just protocol tests.

## Conversation management

| Operation | Native runtime | Sandbox runtime |
|---|---|---|
| Reconnect/reload | Replay the existing journal and continue checkpointed state. | Replay the same journal; restore the committed native checkpoint before subsequent session load. |
| Stop | Cancel the owning native turn and wait for cleanup. | Cancel the actual admitted ACP prompt and its producer/tool/input work; retain saved context. |
| Clear | Retire obsolete journals and remove admitted checkpoint/files. | Delete the exact pinned environment, purge owned checkpoints, then reset its provider reference and canonical files. Cleanup failure remains visible and retryable. |
| Permanent deletion | Fence late admissions, clear native state, then remove canonical history through existing authorization. | Apply the same fence, perform owner-bound generation/version-checked remote cleanup, then finish canonical deletion. Retained volumes/backups follow deployment policy. |
| Rewind | Existing checkpoint rewind. | Restore the selected turn's retained pre-prompt native state and linked native-child checkpoints. A durable edit intent gates later prompts; canonical UI history must be reconciled before continuation. Editing the first turn creates a genuinely fresh native session. Older turns without a retained boundary return an explicit error. |
| Restart runtime | Rebuild the cached native runtime with current resources. | Reconnect ACP/MCP and reload the same pinned native session and workspace. Restart does not delete the environment or replay a prompt. |

A minimal deleted-session ledger prevents late requests from recreating a
permanently removed context. Soft deletion keeps archive/restore behavior.
Clear/deletion does not prove physical erasure of retained provider volumes,
snapshots or backups.

## Operator configuration and qualification

### Retry and execution budgets

| Existing control | Claude Code placement |
|---|---|
| Model retry count | Use the pinned SDK's native retry count within one ACP prompt. CAIPE never resends a whole prompt to emulate inference retries. The SDK owns error classification, timing and the final error; differing configured middleware behavior is reported visibly. |
| Model run limit | Use the native `maxTurns` budget, including the configured default. Exhaustion does not become a successful completion. |
| Platform tool retries | Reuse CAIPE's retry middleware for tools whose server-owned metadata declares read-only or idempotent behavior. Recheck grants, definitions and lease ownership on each attempt; never automatically repeat an uncertain mutation. Workspace callbacks run once around the retry operation. |
| Platform tool run limits | Count requests in the existing durable run record, globally and per configured tool. Repeated observers attach to the same result. Claude's local shell/filesystem tools remain governed by its runtime and environment policy. |
| Thread-wide middleware limits | Explicitly rejected for this placement until their semantics across edits and native sessions are supported. Current SRE run limits do not require these controls. |

The initial SRE cutover runs the whole SRE agent in Claude Code. Native children
already configured on that agent remain available through the existing broker.
A native parent delegating selected tasks to a sandbox child is outside this phase.

Configure these settings on Dynamic Agents; no Compose default or existing
agent is switched by supplying them:

| Setting | Purpose | Default |
|---|---|---|
| `SANDBOX_SERVICE_URL` | Operator-owned control-plane base URL, optionally including its installed base path. The client appends the fixed `/api/caipe` contract. | Empty; sandbox placement unavailable. |
| `HARNESS_TOOLS_PUBLIC_URL` | CAIPE MCP broker base reachable from the sandbox, normally `https://caipe.example.test/api/v1/harness-tools`; the run adds `/{run_id}/mcp`. | Empty. |
| `HARNESS_TOOLS_ALLOW_HTTP` | Explicit private/local exception for plaintext broker transport; HTTPS is the normal contract. | `false` |
| `SANDBOX_PROVISION_TIMEOUT_SECONDS` | Bounded readiness wait; expiry preserves the idempotent environment for retry. | `600`, range 10–1800. |

The provider contract supplies configured profile discovery, idempotent creation,
identity/status, resume/suspend/delete, scoped workspace operations, native-state
export/restore/receipt and a non-TTY ACP relay. Claude Code profiles must advertise
the exact supported state contract; a profile without it is unavailable. It needs independently configured CAIPE issuer/audience/JWKS,
access policy, pinned harness profiles, storage, model Secret references and
routes back to CAIPE. Scheduled owner runs reuse CAIPE's existing owner token
exchange. Other machine runs retain their independently verified service-account
subject, admitted by an operator-owned subject/client pair. Email headers cannot
impersonate a human. Existing CAIPE/CAS grants still decide agent, workflow and
tool access; reconnects reauthenticate. Its API may
expose no arbitrary exec or caller-selected
credential destination. Refer to the [component configuration](https://github.com/caipe-io/ai-platform-engineering/tree/main/ai_platform_engineering/dynamic_agents#sandbox-runtime-configuration)
for the exact request fields and limits.

| Verification | What it establishes |
|---|---|
| Deterministic ACP/MongoDB tests | Serialized events, immutable binding, reconnect, human decisions, capability isolation, child admission, file boundaries and cleanup behavior in source. |
| Offline native resume | The pinned Claude adapter starts a genuine session, checkpoints it with the production archive worker, restores after working-filesystem loss and loads the same native session using loopback inference. It does not establish production model, provider authentication or policy compatibility. |
| Canonical backup recovery | A real MongoDB dump, database deletion and restore recover the checkpoint archive, head, binding and journal. A fresh Claude process loads that recovered archive with its original native session and context. |
| Deployment qualification pending approval | Actual provider login, model gateway, MCP reachability, skills execution, policy enforcement, session restore after process/Pod loss, cancellation and retained-volume lifecycle. |

Use the same `MONGODB_URI`/`MONGODB_DATABASE` for canonical CAIPE records and
include ACP bindings, leases, executions/events, tool requests, checkpoint manifests
and their complete GridFS buckets in one consistent backup. Restoring this
canonical database recovers committed native state as well as CAIPE records;
provider volume backups are optional additional recovery copies. Restored leases
must expire, not restart work. A database backup does not preserve a live process
or the outcome of an in-flight external mutation. Journal limits remain 8 MiB/frame, 64 MiB/run and
100,000 frames/run, with explicit failure instead of successful truncation.

Rollback restores prior image pins through the normal deployment process and
preserves state. It cannot convert an admitted CLI session into a native
checkpoint; retain the compatible runtime or perform an explicit migration.
