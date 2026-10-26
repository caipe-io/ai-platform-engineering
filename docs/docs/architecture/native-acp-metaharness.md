---
sidebar_position: 9
---

# Harness Gateway and native ACP execution

The [CAIPE metaharness proposal](https://github.com/orgs/caipe-io/discussions/2877)
extends the merged [Harness Gateway](https://github.com/caipe-io/ai-platform-engineering/pull/2401)
rather than introducing another router. The authenticated BFF selects the execution
owner and translates its output into the existing client APIs. Default, SRE and
custom agents remain logical agents in the shared DeepAgents/LangGraph runtime;
their start, human-input resume and invoke paths all cross native ACP.

## One front door, one owner per run

```mermaid
flowchart TB
  Clients[Browser, apps, bots and automation] --> BFF[Existing authenticated CAIPE APIs]
  BFF --> Gateway[Harness Gateway and runtime descriptors]
  Gateway -->|Saved managed binding| Native[Native execution service and coordinator]
  Gateway -->|Saved SDK binding| Engine[Harness Engine and provider coordinator]
  Native --> ACP[Logical ACP agent]
  ACP --> Deep[DeepAgents and LangGraph]
  Engine --> Providers[Existing SDK and AgentCore adapters]
  Native --> DB[(Canonical CAIPE MongoDB)]
  Engine --> DB
  Deep --> DB
```

| Boundary | Responsibility |
|---|---|
| BFF gateway | Existing authentication and conversation authorization; descriptor-driven selection; saved execution-owner lookup; client stream translation. |
| Native execution owner | Existing native admission leases, runtime lifetime, ACP dispatch, human input, tools, files and replay journal. |
| Engine execution owner | SDK/provider session binding, detached execution and provider event journal. |
| Client | Existing visible-message writer and presentation; reconnect after a consumed cursor without submitting another prompt. |

An immutable `harness_gateway_bindings` routing reference atomically selects
one owner per agent and authorized execution context at first admission.
Read-only lookups do not pin a new context, and existing backend bindings
remain authoritative evidence when establishing that reference. It stores no
provider session, prompt, token or journal.

Each run belongs to exactly one coordinator and journal. Engine does not wrap
`AgentExecutionService.start_run`, and native execution does not copy its output
into Engine collections. Both use the canonical CAIPE MongoDB. A saved binding
selects the owner before the current agent default is read; changing an agent
cannot redirect an active or retained conversation into another runtime. Installed app
claims follow the same rule: retained ownership is checked before app dispatch,
and an app-only invoke rejection cannot hide a saved native/provider binding.
Conversely, a server-managed `conversation.app_binding` retains external app
execution and fails closed if that installation is removed or rebound. New app
admissions record that binding on the existing conversation. Editable overlay
metadata only associates a conversation with an app UI; Managed and SDK overlays
continue to use their ordinary retained backend. Older external app histories
without a server binding require explicit adoption before relying on that
retained-app guarantee. App/native cutovers
require quiescent migration because existing app streams do not share the native
and SDK backends' atomic admission contract. Missing
provider configuration and inconsistent bindings fail explicitly.

The gateway reuses its existing descriptor catalog, editor, harness badges and
SDK/AgentCore adapters. Those adapters retain their qualified provider contracts;
appearing in the same catalog does not make them ACP implementations. Native
DeepAgents uses ACP by default, without an enablement flag. The separate
[coding-sandbox extension](https://github.com/caipe-io/ai-platform-engineering/pull/2982)
adds an opt-in placement through this same selector and gateway.

## Native execution and feature preservation

The native ACP client and logical agent exchange JSON-RPC inside Dynamic Agents.
This is an interaction boundary, not a new deployment or public ACP endpoint.
Capability negotiation precedes prompting, and the client converts validated
native progress into the existing AG-UI or custom SSE frames.

| Native contract | Behavior |
|---|---|
| Runtime | Keep DeepAgents/LangGraph, MCP integrations, native subagent delegation and logical files. ACP does not grant a real host filesystem. |
| Protocol | Pin Python SDK 0.12.1 and wire protocol 1. Typed `caipe.io/native-acp` metadata and acknowledged `_caipe/event` requests preserve the native features beyond standard progress. |
| Session identity | Reuse the original native thread and admitted storage coordinates. Do not reconstruct executable state from the UI transcript. |
| Human input | Preserve checkpointed forms and edited batch approvals, exact pending identities and current narrowed MCP, built-in, URL-domain, workflow and subagent grants. |
| Client output | Preserve attachments, tool/subagent progress, reasoning and native form detail through both existing encodings. |
| Automation | Keep the workflow engine, scheduler and invoke lifetimes and their authorized execution-context mappings. |

LangGraph chunks are interpreted once into typed events. Neither the logical
agent nor the protocol bridge parses UI event strings to infer execution state.
Runtime construction, binding validation and administrative deletion share the
native storage resolver. The native bridge does not advertise unsupported ACP
session loading, listing/forking, client filesystem or terminal capabilities.
A new connection for a turn reuses trusted native state without repeating history.

For retained Engine runs, the BFF projects the provider's committed canonical
events into standard client frames. Its cursor also records the projected part
within an event, so reconnecting between parts cannot lose or repeat output.
The projection does not create another persisted journal. Native frame cursors
retain their existing strict ordering and validation.

The [gateway discussion](https://github.com/orgs/caipe-io/discussions/2405)
provides the shared session-management foundation. This extension retains native
feature and lifecycle protections behind that foundation. Runtime choice,
interaction protocol and sandbox placement remain distinct contracts.

## Sessions and the canonical database

The admitted effective agent configuration and its session binding are stored
in `native_acp_sessions`, in the same configured MongoDB database as CAIPE
records and native checkpoints. The binding uses the agent ID and original
native session ID. It does not copy the checkpoint into a new history format
or store caller tokens and MCP credentials.

| State | Owner and persistence |
|---|---|
| Admitted agent configuration and execution binding | The native ACP integration stores the effective configuration snapshot and binding in `native_acp_sessions`. |
| Active-turn ownership | `native_acp_runs` stores an owned lease for each agent/session pair so multiple replicas coordinate admission and cancellation. |
| Native runtime state | LangGraph continues to use the existing checkpoint collections and thread IDs. DeepAgents files retain their existing storage namespace. |
| Interactive conversation messages and progress | The browser still writes the existing CAIPE conversation records through the BFF. |
| Workflow and automation history | Existing services keep their current history-writing responsibilities and execution-context mapping. |
| Streaming run lifecycle and replay | `native_acp_execution_runs` stores request identity, native lease association and outcome; `native_acp_execution_events` stores sequenced stream frames in canonical MongoDB. The service owns execution and clients subscribe independently. |

Normal interactive conversation IDs and automated execution-context IDs keep
their existing relationship to LangGraph `thread_id`. New ACP bindings must not
rename those threads or invalidate existing checkpoints. Ordinary `/invoke`
continues to honor `INVOKE_PERSIST_HISTORY`; the ACP boundary does not make an
ephemeral invocation durable.

Admission acquires the turn lease before updating the binding or runtime
cache. A unique agent/session index permits one owner; the worker extends a
120-second lease and polls cancellation every second. Cancellation can reach
the owner even when its HTTP request lands on a different replica. Caller
identities, tokens and tool credentials are not stored in either ACP collection.

Workers need synchronized clocks. If a lease expires, another worker can
admit a later request using the existing native checkpoint. Expiry does not
automatically restart the previous run or provide exactly-once external tool
effects. The run journal replays already persisted output without calling tools.
A run whose worker lease disappears or expires becomes explicitly interrupted. A stale worker is not fenced from an
external service by this MongoDB lease. Ephemeral `/invoke` uses transient
turn coordination while retaining its existing nonpersistent history behavior.

Starting a subsequent turn admits the latest effective agent configuration so
existing prompt, model and reasoning edits continue to work. The first
admitted backend/checkpoint/filesystem binding remains fixed. Human-input
resume restores the last admitted configuration after runtime-cache eviction,
including workflow overrides. Resume intersects its saved tool scope with the
current validated definition so removing or narrowing MCP tools and selected
remote-agent tools takes effect
without expanding the saved scope. Configuration snapshots have the same
sensitivity as agent definitions and need the same database access controls.
They are not a redaction layer for sensitive values placed in prompts or
middleware configuration. Changing the database, checkpoint collection or
file-store coordinates of an existing binding fails admission rather than
silently pointing the session at different state; migrate that state first.
Snapshot integrity is checked against the stored configuration before new
optional model defaults are applied. Adding a configuration field must not make
a previously valid session unreadable; the next admission records the current
normalized configuration while retaining the same native state.

The gateway owns `harness_gateway_bindings`; retain those routing references
and the canonical deletion ledger in the same backup. Engine owns its `harness_sessions`, `harness_runs`, `harness_events` and provider
revision/session-store collections. Native ACP owns the collections described
above. These are different execution owners' records, not competing histories
for a single run. Engine admission reserves its binding before asynchronous
preparation and rechecks the producer fence before dispatch. An identical
request attaches to its existing run; changed input conflicts. A recoverable
event intent is reconciled before the committed replay head is exposed, including
on standalone MongoDB. Missing or expired output fails explicitly.

Configure the UI, Dynamic Agents and Harness Engine to use the same
`MONGODB_URI` and `MONGODB_DATABASE`. Include the new ACP collections and native checkpoint/file
collections in that database's existing backup and restore procedures. Restored
lease records can expire; they are not instructions to restart a run. The
implementation does not migrate transcripts
or consolidate databases that a deployment previously configured separately.

## Identity and filesystem boundaries

Existing authenticated caller identity, agent authorization and tool credential
delegation remain the admission boundary. ACP negotiation is not an
authorization grant. A caller must still have permission to use the agent and
the conversation or automated execution context.

Existing chat-management requests retain their BFF conversation authorization.
Stopping an active run keeps the existing cancellation semantics, including
when agent-use permission has been revoked. This stage adds no remote ACP
endpoint with a separate authentication contract.

Cached runtimes are refreshed when the admitted configuration, current caller,
client context or bearer changes. Each request therefore uses its current
authorization and tool credential context rather than retaining the caller who
first initialized the cache entry.

DeepAgents retains its logical filesystem, backed by its existing checkpoint or
MongoDB file store. The ACP wrapper does not grant access to the host filesystem
or create a per-agent sandbox. Existing tool-level network controls still apply;
ACP itself does not enforce an operating-system network policy.

Future SDK agents in the shared service must use that same simulated filesystem
contract. Their agent-visible file operations need to use the session-scoped
logical store, with built-in host file and shell tools disabled. SDK-private
transcript scratch, if required by a provider, is distinct from the filesystem
available to agent tools. A remote provider must enforce its approved tool/file
profile at the runtime or a trusted broker; ACP negotiation alone cannot impose
those restrictions on remote code.

## Durability and compatibility acceptance

Preserving current durable behavior is an acceptance gate for this migration.
ACP session creation must not create a new CAIPE conversation, rename the native
thread, replay stored messages as new turns, or discard an outstanding approval.

| Existing behavior | Required verification |
|---|---|
| A conversation created before ACP | Its original checkpoint, turn IDs, CAIPE transcript rows and logical files remain available on its first ACP turn. |
| Cache eviction or a new worker | Reconstruct the native graph from MongoDB with the admitted storage binding and continue the same thread. |
| Pending human input | Restore both form input and batched edit/reject tool approvals from pre-ACP and ACP checkpoints, then resume without duplicating the turn. |
| Conversation management | Rewind, restart and clear use the admitted checkpoint/file coordinates and leave other sessions intact. |
| Current tool integrations | Preserve subagent, attachment and remote-tool progress events across serialized ACP and both existing UI stream formats. |
| Caller and workflow contracts | Retain authorization, refreshed credentials, narrowed tool scope, explicit cancellation and persistent/ephemeral invocation behavior. |

`tests/test_native_acp_mongodb.py` runs migration, reconstruction and approval
cases against an isolated real MongoDB, using a deterministic graph instead of
model calls. The Dynamic Agents CI job supplies MongoDB so these checks execute
on every PR run. Local runs may set `NATIVE_ACP_TEST_MONGODB_URI`; each test owns
and removes a random test database. The test does not use a deployed application
database or establish provider/sandbox readiness.

### Reconnect and browser reload

Streaming start and human-input resume admit a service-owned task with a stable
turn identity. The browser saves the user turn and assistant placeholder through
the existing conversation writer before starting it. Closing a tab or dropping
the stream disconnects that subscriber; it does not cancel execution. Explicit
Stop requests still cancel the native owner and wait for its cleanup.

```mermaid
sequenceDiagram
  participant UI as Browser
  participant Service as Native run coordinator
  participant Runtime as Logical ACP agent
  participant DB as Canonical MongoDB
  UI->>Service: Start a validated turn with a stable turn ID
  Service->>DB: Reserve request identity
  Service->>Runtime: Execute under the existing native lease
  loop Native progress
    Runtime->>Service: Existing protocol frame
    Service->>DB: Persist frame, then publish its cursor
    Service-->>UI: Frame with run ID and sequence
  end
  Note over UI,Service: A lost connection leaves execution running
  UI->>Service: Read status and subscribe after the consumed cursor
  Service->>DB: Read persisted events
  Service-->>UI: Replay remaining frames and durable outcome
```

| Situation | Result |
|---|---|
| Temporary network loss | Reconnect to the same run after the last consumed sequence. Never resubmit the prompt to recover output. |
| Browser reload or detached completion | Locate the run for the saved turn and reconstruct its unfinished assistant message from the journal, then use the existing message upsert. |
| Clear or rewind native context | Retire prior replay journals under the native session lease so old output or an obsolete approval cannot reappear. The canonical conversation writer keeps its existing history responsibilities. |
| Retry with the same turn identity | Attach to the original run. Reusing that identity with changed validated input fails with a conflict. |
| Human-input pause | Persist an awaiting-input outcome. A submitted form or batch approval has its own stable turn identity so retries do not apply it twice. |
| Worker loss | Keep checkpoints and persisted output, report interruption and do not automatically repeat tools. |
| Journal gap or unavailable database | Return an explicit replay/storage failure instead of presenting partial output as a complete response. |

Run and turn identities in JSON retain their original values. The optional
`X-CAIPE-Turn-Id` response header percent-encodes opaque IDs so Unicode or control
characters cannot invalidate an admitted stream. UUID turn IDs are unchanged.

Both UI encodings retain their exact persisted message and tool IDs. Every frame
has a monotonic cursor; a final `CAIPE_RUN_STATUS` control event confirms the
durable outcome. Reading status or replay requires agent-use and conversation
read access through the existing authorization boundary. The backend additionally
checks the original caller identity or canonical conversation-read permission.
Credentials stay in the running task's memory, never in the journal.

The browser remains the interactive transcript writer. The journal is durable
execution output for recovery, not another independently authored conversation.
A minimal `native_acp_deleted_sessions` ledger prevents a request admitted around
permanent deletion from recreating that session. It retains only the removed
session ID and deletion timestamp, with no output or credentials. Soft deletion
keeps the existing archive/restore behavior.

The journal contains agent output and tool results, so apply the same access, backup
and restoration controls as conversation and checkpoint data.

Journal writes are bounded to 8 MiB per frame, 64 MiB per run and 100,000 frames
per run. Exceeding a bound produces an explicit failed outcome; it never silently
truncates a successful turn. Replay uses bounded pages and no subscriber queue.
No automatic journal expiry is introduced; these collections participate in the
canonical database's retention and backup policy. This phase does not implement
automatic recovery of execution after worker loss or exactly-once tool effects.

Remote ACP transport, agent discovery across environments and sandbox policy
enforcement are later stages. Separate sandboxed runtimes will require enforced
filesystem and network boundaries before admission. This implementation does
not add OpenShell or NemoClaw execution.

## Deployment and rollback

ACP is part of the Dynamic Agents execution path. Deploy the service image
through the existing Helm/GitOps process; no separate ACP enablement setting is
required. The HTTP API, native thread IDs and cached, persistent or ephemeral
runtime lifetimes retain their existing roles.

To undo a release, restore the previous image pin and release values through
the normal deployment process. Keep binding, checkpoint, file and conversation
collections intact. Deployment rollback changes the deployed version rather
than selecting another execution path inside this implementation.

See the [Dynamic Agents configuration reference](https://github.com/caipe-io/ai-platform-engineering/tree/main/ai_platform_engineering/dynamic_agents#configuration-reference)
for component settings.

### Read authorization and transient storage loss

Shared readers authorize against the visible CAIPE conversation. When automation
uses a separate execution-context ID, the native backend independently verifies
the canonical conversation-to-runtime and agent mapping before reading retained
output. An arbitrary supplied conversation alias grants no access.

A failed cancellation read or heartbeat acknowledgement is not itself proof that
a producer lost authority. Retry transient database failures within the last
confirmed lease budget, without extending that budget on an uncertain write.
Stop execution at lease expiry or explicit revocation, including when a database
call remains blocked, and drain cleanup before releasing the session.
