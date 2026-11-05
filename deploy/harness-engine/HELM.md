# Optional Kubernetes runtimes

The CAIPE umbrella chart can deploy Engine and independent SDK, SDK ACP and
Code CLI ACP workers. All are off by default. AgentCore is an external AWS
deployment and has no worker Pod in this chart.

## Required configuration

- Set `global.harnessEngine.enabled: true`.
- Set `global.harnessEngine.tokenSecret` to an existing Secret name/key shared
  by BFF and Engine. Templates never generate tokens or look up live Secrets.
- Set `harnessEngine.mongodbSecret` explicitly. All runtimes use MongoDB;
  missing configuration fails rendering, and absent Secret keys prevent startup.
- Configure model profiles and credentials through `engine.env`, `secretEnv`
  and `envFromSecrets`. Token-bearing worker profile JSON belongs in a Secret.
  Keep each worker's service credential distinct from the Engine credential.
- Enable selected entries under `harnessEngine.workers`: `sdk`, `sdk-acp`,
  `cli-acp`. Set each `tokenSecret`, model profile and provider Secret references.
- Set `harnessEngine.egress.allowedDomains` to exact public TLS model hostnames.
  Declare narrowly scoped MongoDB rules in `networkPolicy.databaseEgress`.
  The worker gate rejects missing network policy, proxy, database rules or hosts.
- Pin `image.digest` for Engine, enabled workers and proxy. SDK Remote reuses
  `caipe-harness-engine`; the default Engine image includes Deep Agents.

Example connection settings, after creating the referenced Secrets:

```yaml
global:
  harnessEngine:
    enabled: true
    tokenSecret: {name: example-engine-token, key: token}
harnessEngine:
  mongodbSecret: {name: example-database, key: uri}
  workers:
    cli-acp:
      enabled: true
      tokenSecret: {name: example-worker-token, key: token}
  egress:
    allowedDomains: [model.example.com]
  networkPolicy:
    databaseEgress:
      - to:
          - podSelector: {matchLabels: {app: example-database}}
        ports: [{protocol: TCP, port: 27017}]
```

## Persistence and handoff

- Every runtime has one replica, a persistent workspace and `Recreate` upgrades.
  Select `persistence.storageClass`, or supply `persistence.existingClaim`.
  Generated claims carry a keep annotation; preserve them during rollback.
- Native Claude transcripts require the original worker volume. This is not a
  cross-replica workspace or automatic takeover mechanism.
- Before enabling `global.harnessEngine.deepAgentsEnabled`, set
  `harnessEngine.attachmentsClaimName`. Mount that **same** claim at
  `/var/lib/caipe-attachments` through Dynamic Agents' existing `volumes` and
  `volumeMounts` settings. Upgrade both producers before adopting old sessions.
- Use RWX storage for independently scheduled producers. RWO storage requires
  deliberate same-node placement of Engine and Dynamic Agents. Existing chats
  are not automatically migrated.

## Enforced controls and cluster requirements

- Non-root UID/GID 65532, read-only root, dropped capabilities, no privilege
  escalation, RuntimeDefault seccomp, no Kubernetes service-account token,
  CPU/memory limits and bounded memory-backed temporary storage.
- Images include Tini as PID 1; Kubernetes has no Docker Compose `init` switch.
- Workers accept control requests only from Engine. Egress is limited to DNS,
  the BFF, configured database rules and the proxy. The proxy allows TLS CONNECT
  to selected public model hosts and rejects private/metadata destinations.
- An enforcing CNI is required. Verify actual direct-egress and metadata denial
  before admitting users; rendering a NetworkPolicy does not prove enforcement.
- Keep the default Kubernetes DNS selector only when it matches the cluster.
  Explicitly configure database subnet rules for external MongoDB/DocumentDB.
- Kubernetes Pod resources do not configure a per-Pod PID limit or `noexec`
  emptyDir mounts. Enforce PID limits through kubelet `podPidsLimit` and apply
  required mount restrictions through the workload runtime/storage policy.
- Deep Agents and SDK Local share Engine's trust domain. Workers are for
  controlled trusted use; this is not isolation for mutually untrusted tenants.

## Rotation, upgrade and rollback

- Drain active runs and tools before replacing workers or rotating tokens.
  Referenced Secret changes use Reloader when that controller is installed.
- Without Reloader, update all referenced Secrets, increment
  `global.harnessEngine.configurationRevision`, and roll BFF, Engine and workers
  together. The shared revision changes every participating Pod template.
- Validate health, model access, shared replay, Stop/drain and native continuation.
  Roll back image digests and configuration as one change; keep workspace claims.
- Unconfirmed provider/tool execution retains its reservation. Pod replacement
  alone is not proof that an external tool completed or was cancelled.
