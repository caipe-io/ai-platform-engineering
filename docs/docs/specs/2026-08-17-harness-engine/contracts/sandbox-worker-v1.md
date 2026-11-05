# Sandbox Worker Protocol v1

## Purpose

This private protocol connects the trusted Harness Engine control plane to one claim-exclusive harness worker in a Kubernetes Agent Sandbox pod. It is not a public API and does not replace the existing REST, custom SSE, or AG-UI contracts.

Provider SDK objects never cross this boundary. Requests are normalized contract values; responses are [Canonical Events v1](./canonical-events-v1.md).

## Transport

- Cluster-private HTTP/2 streaming is the baseline transport; gRPC may implement the same message schema.
- The worker exposes only readiness, start, resume, cancel, pending-interrupt, and shutdown operations.
- No Kubernetes Ingress or public Service exposes a worker.
- Requests and responses are bounded, deadline-aware, cancellable, and trace-correlated.
- The control plane verifies that the claim is bound to the allowlisted profile/template and that admission policy fixed a signed worker image digest; it then negotiates the expected worker protocol before sending a turn.

## Identity and fencing envelope

Every mutating request, event, state call, and ToolBroker call contains:

```yaml
protocol_version: 1
binding_id: hs_opaque_key
epoch: 0
lease_generation: 3
run_id: run_opaque
request_id: request_opaque
idempotency_key: opaque
traceparent: 00-...
deadline: 2026-08-17T00:01:00Z
```

Rules:

- The control plane accepts traffic only when binding, epoch, generation, and run match committed state.
- A worker accepts only one binding and generation for its lifetime.
- Replacement commits a higher generation before the new worker can start.
- A lower or unknown generation returns `409 stale_lease` and produces no event, state mutation, or tool side effect.
- Run and request IDs are opaque and reveal no caller identity.

## Authorization

The worker authenticates with workload identity and a short-lived capability minted by Harness Engine. The capability is audience-bound to `harness-worker`, scoped to one binding/epoch/generation, and expires no later than the run deadline.

The worker receives no:

- end-user or service-account bearer token;
- MCP/tool credential;
- MongoDB, OpenFGA, credential-service, audit-service, or Kubernetes credential;
- arbitrary environment secret or host configuration directory.

ToolBroker calls use a separate short-lived capability scoped to the exact run and allowed tool IDs. ToolBroker repeats caller/tool authorization and rejects stale generations.

## Operations

### `GET /internal/v1/ready`

Returns:

```yaml
ready: true
protocol_versions: [1]
harness_id: strands
adapter_version: 1.0.0
worker_image_digest: sha256:...
bound: false
```

Readiness fails if the worker cannot initialize its adapter dependencies, workspace, or protocol server. It performs no model or tool call.

### `POST /internal/v1/bind`

Binds a fresh worker to one binding/epoch/generation and supplies immutable construction data:

- normalized agent and model configuration;
- rendered prompt and safe client/user context;
- portable tool descriptors and ToolBroker endpoint/capability;
- skill and file manifests with scoped read handles;
- interrupt, middleware, thread-state, memory, resource, event, and telemetry facades/limits;
- provider endpoint alias or egress-proxy route, never a raw long-lived secret.

The worker rejects a second or different binding. Model authentication is injected by an external egress proxy or provider-managed identity boundary; a harness that requires a raw credential inside the worker is unavailable under the production sandbox profile.

### `POST /internal/v1/runs:start`

Accepts a normalized `TurnInput`. The response is a streaming sequence of canonical events beginning with `run.started` and ending in one terminal event.

### `POST /internal/v1/runs:resume`

Accepts a canonical `ResumeDecision` with interrupt revision and streams one canonical lifecycle. Duplicate identical decisions are idempotent; conflicts return `409`.

### `POST /internal/v1/runs:cancel`

Idempotently requests cancellation for the active run. The worker stops provider/event production, cancels subprocesses where possible, and emits `run.cancelled` if the stream remains available. Cancellation does not assert that an external side effect was undone.

### `GET /internal/v1/interrupt`

Returns the canonical pending interrupt summary or `204`. It never returns provider-private state or credentials.

### `POST /internal/v1/shutdown`

Stops the harness, child processes, model streams, and temporary files within a bounded deadline. Kubernetes claim deletion remains the authoritative termination mechanism.

## State and files

- Durable provider state is accessed through a binding-scoped state facade; workers never receive a database handle.
- Existing files and attachments use scoped, expiring object handles or broker operations.
- Pod-local workspace is disposable. A certified adapter must reconstruct required state after eviction.
- Optional PVC profiles require encrypted storage, binding-exclusive attachment, retention rules, and path/symlink isolation tests.
- State writes carry expected binding revision and lease generation.
- Thread-state commits and memory writes use different scoped facades, namespaces, revisions, and retention rules.
- Workers propagate sanitized W3C Trace Context to those facades but never use it as authorization.

## Event handling

- Workers translate provider output to canonical events before transmission.
- The control plane validates schema, size, ordering, identifiers, namespace, and generation again.
- The control plane is the only component that encodes public SSE or AG-UI frames.
- Backpressure is bounded. If the client disconnects or buffers fill, the control plane cancels the worker run.
- Late events after a terminal event, cancellation, deadline, or lease replacement are discarded and metered.

## Network policy

Default deny applies to ingress and egress.

Allowed ingress:

- Harness Engine control-plane namespace/service identity to the worker port.

Allowed egress:

- cluster DNS;
- Harness Engine ToolBroker/state/file broker endpoints;
- one selected model endpoint or credential-injecting egress proxy;
- explicitly approved artifact endpoints for a certified profile.
- the in-cluster OpenTelemetry Collector or control-plane telemetry facade.

Forbidden by default:

- Kubernetes API;
- MongoDB, OpenFGA, credential service, metadata services, and other cluster workloads;
- arbitrary internet, DNS-over-HTTPS, SMTP, and raw cloud metadata endpoints.

## Errors

Worker errors use the Harness Adapter v1 categories and add:

| Code | Category | Meaning |
|---|---|---|
| `stale_lease` | authorization | Binding/epoch/generation is no longer current. |
| `worker_mismatch` | configuration | Harness, adapter, image digest, or protocol differs from the profile. |
| `sandbox_not_ready` | unavailable | Claim exists but worker readiness failed. |
| `sandbox_capacity` | capacity | Claim or warm-pool capacity is exhausted. |
| `sandbox_evicted` | unavailable | Pod disappeared during execution; replay safety is unknown. |
| `sandbox_limit` | capacity | CPU, memory, PID, storage, or lifetime limit terminated work. |

Safe errors contain no command output, provider stderr, environment values, paths containing identities, or Kubernetes internals beyond an opaque incident correlation ID.

## Conformance

Certification requires:

1. distinct claim and pod UIDs for concurrent bindings;
2. same-binding reuse and cross-replica control-plane reconnect;
3. eviction, hibernation, expiration, clear, replacement, and orphan reconciliation;
4. stale event, state write, resume, and ToolBroker-call fencing;
5. no cross-binding filesystem/process/environment/network/state visibility;
6. zero raw credential canaries in environment, mounts, process arguments, logs, core dumps, and artifacts;
7. default-deny egress and metadata/Kubernetes API denial;
8. resource-limit and infinite-loop containment;
9. canonical stream compatibility, backpressure, cancellation, and client disconnect;
10. warm-pool claim exclusivity and destroy-on-release;
11. signed image, expected digest, RuntimeClass, Pod Security, seccomp, and capability-drop verification;
12. 1,000-binding isolation and capacity testing.
13. durable thread restore and ambiguous-commit behavior;
14. user/agent/organization memory scope and revision-conflict behavior;
15. end-to-end trace propagation, redaction, and bounded collector-outage behavior.
