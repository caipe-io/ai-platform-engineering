# Dynamic Agents Compatibility Matrix

This matrix is the migration oracle. Implementation must attach concrete test IDs and results before changing a row from `planned` to `proven`.

## Status legend

- `existing`: behavior exists in Dynamic Agents today.
- `planned`: Harness Engine design assigns ownership but has no implementation evidence yet.
- `proven`: unchanged baseline and adapter conformance tests pass.
- `blocked`: a certified implementation is not available; the adapter cannot be advertised as supported.

## External surface

| Behavior | Current owner | Harness Engine owner | Deep Agents | Claude SDK | Strands | AgentCore |
|---|---|---|---|---|---|---|
| Existing health/readiness/debug routes | FastAPI service | Common routes | planned | planned | planned | planned |
| Existing chat start/resume/invoke/cancel/restart routes | Chat routes | Common routes/coordinator | planned | planned | planned | planned |
| Existing conversation interrupt/metadata/clear routes | Conversation routes | Common routes/session repository | planned | planned | planned | planned |
| Existing file list/get/put/delete/namespace routes | File routes/GridFS | Common file service | planned | planned | planned | planned |
| MCP probe, built-in tools, middleware, suggestion routes | Existing routes | Common routes/services | planned | planned | planned | planned |
| Custom SSE bytes and ordering | LangGraph encoder | Canonical custom encoder | planned | planned | planned | planned |
| AG-UI bytes and ordering | LangGraph encoder | Canonical AG-UI encoder | planned | planned | planned | planned |
| Existing errors/status/retry headers | Routes/runtime cache | Common routes/coordinator | planned | planned | planned | planned |

## Agent creation and editing

| Behavior | Current baseline | Harness Engine UI rule | Certification evidence |
|---|---|---|---|
| Editor navigation | Fixed `basic`, `instructions`, `tools`, `skills`, `advanced` steps | Preserve IDs and URLs; vary content by field capability | Existing deep-link and editor tests unchanged |
| Legacy/default harness | No harness field | Resolve to `deepagents` at read time; do not rewrite on open | Legacy create/edit/clone regression |
| Harness and model selection | One global model list | Select harness first; filter models; preserve incompatible stored value as blocker | Catalog/model matrix tests |
| Tools, skills, middleware, subagents | Always rendered | Native/emulated enabled; unsupported/unavailable visible and actionable | Field capability projection tests |
| Thread persistence | Implicit runtime behavior | Read-only durability/restore summary | Summary matches descriptor and validation |
| Long-term memory | No portable builder policy | Common scoped policy controls bounded by deployment policy | Scope/approval/retention UI tests |
| Harness-specific options | None | First-party typed panels backed by bounded JSON Schema | Schema/UI parity and unsafe-field rejection |
| Harness switch | Not applicable | Preview diff; explicit individual fixes; no silent deletion | Draft round-trip/property tests |
| Active conversations | Same runtime | Existing bindings pinned; new conversations use saved harness; confirm change | Update with active/persisted binding tests |
| Unknown/unavailable stored harness | Not applicable | Preserve, display, and block unsafe save; never coerce to default | Catalog outage/version skew tests |
| Save validation | Local required fields + BFF CRUD | Browser preflight plus exact-payload BFF revalidation/fingerprint before writes | Race and no-partial-mutation tests |
| Accessibility | Existing form controls | Keyboard/card/dialog/error-focus semantics; text labels beyond color | Automated and manual accessibility tests |

## Security and identity

| Behavior | Common implementation | Adapter obligation | Certification evidence |
|---|---|---|---|
| JWT validation and request context | Existing middleware | Cannot bypass | Existing auth tests unchanged |
| Agent-use OpenFGA/PDP gate | Existing route dependency | Invoked only after allow | Denial proves zero adapter calls |
| Workflow delegated authorization | Existing route/tool policy | Preserve caller/service subject | User and service-account tests |
| Per-user MCP credentials | ToolBroker/credential exchange | Use only supplied handles | Concurrent caller isolation test |
| Signed agent context to gateway | ToolBroker HTTP factory | No direct spoofing | Header/signature contract tests |
| Secret and skill trace scrubbing | Common telemetry pipeline | Link spans through scrubber | Leak canary scan |
| SSRF/domain restrictions | Built-in ToolBroker tools | No native bypass | Redirect/private-network tests |

## Execution baseline

| Capability | Common or emulated path | Deep Agents native path | Claude SDK path | Strands path | AgentCore path |
|---|---|---|---|---|---|
| Streaming text | Canonical events | LangGraph messages | SDK stream messages | async stream events | InvokeHarness deltas |
| Reasoning/thinking | Canonical optional channel | model chunks | thinking blocks/events | reasoning events | reasoning content deltas |
| Tool lifecycle | ToolBroker + canonical events | LangChain tools | SDK MCP tools | Strands tool wrappers | inline functions |
| MCP partial failure/retry | ToolBroker | existing client | common broker | common broker | common broker via inline tools |
| Built-in tools/workflows | ToolBroker | existing wrappers | SDK MCP wrappers | Strands wrappers | inline functions |
| HITL form input | Canonical interrupt | request_user_input interrupt | user-input/tool callback | Strands interrupt | inline function pause |
| HITL approve/edit/reject | Common approval record | LangGraph HITL | permission callback | before-tool interrupt | inline function result loop |
| Multiple tool approvals | Common approval record | existing batch interrupt | adapter aggregation | adapter aggregation | adapter aggregation |
| Thread persistence | ThreadStateStore + durable binding head | Existing Mongo checkpointer | Mongo SessionStore through state facade | Mongo SessionRepository through state facade | remote session binding + committed state reference |
| Long-term agent memory | MemoryBroker scopes/policy | StoreBackend-compatible facade | SDK memory only through broker | Strands memory only through broker | inline governed memory tools until native equivalence is proven |
| Clear/restart | Common epoch/lifecycle | checkpoint delete/cache reset | store delete/new session | repo delete/new session | new epoch/session |
| Cancellation | Common cancellation policy | task flag/cancel | SDK interrupt/process cleanup | cancellation token/task cancel | close stream/remote stop if supported |
| Attachments | Common validation/store | current model blocks | SDK supported content/workspace | provider content blocks | supported input or engine tool access |
| Skills | Common scan/materialization | Deep Agents skills files | SDK skills/project materialization | Strands skill/plugin materialization | Harness skills where certified |
| Subagents | DelegationBroker | existing task behavior | portable delegation tool | portable delegation tool | inline delegation function |
| Middleware outcomes | Common policies + adapter map | existing middleware | hooks/options/emulation | hooks/emulation | common boundary/remote config |
| Metrics/tracing | W3C context + common spans/redaction | worker OTel linked | SDK/worker OTel linked | hooks/worker OTel linked | AgentCore telemetry safely linked |

## Data and deployment compatibility

| Artifact | Migration rule | Rollback behavior |
|---|---|---|
| `dynamic_agents` documents | Add optional `harness`; missing means `deepagents` | Old service ignores additive field |
| MCP/skills/provider collections | No schema change | Same collections remain authoritative |
| LangGraph checkpoints/writes | No rewrite | Old service resumes Deep Agents conversations |
| GridFS and attachment store | No rewrite | Old service uses same namespaces/references |
| `harness_sessions` | New additive collection | Old service ignores it |
| `harness_memories` | New additive policy-governed collection; disabled unless configured | Old service ignores it; no memory is backfilled into old runtime |
| Conversation metadata | Additive harness binding summary only if needed | Old readers ignore new metadata |
| Service DNS/chart/env | Preserve existing names | Rollback changes image only |

## Isolation and execution placement

| Behavior | Deep Agents | Claude SDK | Strands | AgentCore | Certification evidence |
|---|---|---|---|---|---|
| Production execution boundary | Claim-exclusive pod | Claim-exclusive pod plus SDK subprocess | Claim-exclusive pod | Provider-managed remote session | Descriptor/profile matches observed boundary |
| Scope | One Sandbox UID per conversation epoch | One Sandbox UID per conversation epoch | One Sandbox UID per conversation epoch | One provider session per binding epoch | Concurrent binding/UID uniqueness test |
| Follow-up turns | Reuse same healthy lease | Reuse same healthy lease | Reuse same healthy lease | Reuse bound provider session | Stateful multi-turn test |
| Durable recovery | Mongo LangGraph checkpoints + workspace hydration | Mongo SessionStore + workspace hydration | Mongo SessionRepository + workspace hydration | Managed session + binding | Kill pod/control-plane and resume on another replica |
| Tools and credentials | External ToolBroker; no raw secret in pod | External ToolBroker; no raw secret in pod | External ToolBroker; no raw secret in pod | Inline tools through ToolBroker | Credential canary and broker authz tests |
| Kubernetes authority | No worker API token | No worker API token | No worker API token | None | Token/mount/API denial test |
| Network | Default deny + model/proxy/brokers | Default deny + model/proxy/brokers | Default deny + model/proxy/brokers | Provider policy + control-plane AWS endpoint | Egress conformance test |
| Stale worker fencing | Binding epoch + lease generation | Binding epoch + lease generation | Binding epoch + lease generation | Binding epoch + remote session/version | Late event/tool/state rejection test |
| Warm start | Exclusive warm-pool claim | Exclusive warm-pool claim | Exclusive warm-pool claim | Provider-managed | p95 readiness and destroy-on-release test |

## Persistence, memory, and trace invariants

| Invariant | Common owner | Adapter/worker obligation | Evidence |
|---|---|---|---|
| Final durable thread head | ThreadStateStore/session binding | Persist native state before durable completion | Crash-point and head-revision tests |
| Ambiguous post-output failure | Coordinator | Stop/fence; never auto-replay side effects | Tool-side-effect fault injection |
| Cross-replica/pod restore | Session binding + state facade | Load exact codec/version/head | Random eviction/restart suite |
| User memory isolation | MemoryBroker | Use only supplied scope/facade | Concurrent cross-user probes |
| Shared memory safety | MemoryBroker policy | Respect read-only/approval/conflict outcomes | Injection and revision tests |
| Trace parentage | Telemetry pipeline | Extract/inject internal W3C context | Full topology assertion |
| Trace confidentiality | Common scrubbers/collector | Emit allowlisted metadata only | Canary leak scan |
| Collector outage | Bounded telemetry pipeline | Never change run/durability result | Outage/load test |

The existing `backend.type: sandbox` field is a Deep Agents filesystem/execute backend choice, not this execution-placement boundary. Harness Engine must not treat that legacy field as proof that the harness itself runs outside the API container.

## Certification rule

The four adapter columns describe intended mappings, not current proof. Before a provider is shown as `certified`, every applicable row must link to a passing conformance test, and the provider-specific limitations must not weaken the common behavior. A row that cannot be proven changes the adapter to `experimental` or `blocked`; it does not change the baseline.
