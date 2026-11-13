---
sidebar_position: 5
---

# Persistence

CAIPE stores platform state through the MongoDB wire protocol. DocumentDB is
the default provider for new installs; MongoDB remains supported as an opt-in
alternative.

## What Persists

| Data | Owner | Storage |
|---|---|---|
| Conversation list and metadata | UI/BFF | `conversations` collection |
| Dynamic-agent checkpoints | Dynamic Agents | `checkpoints_conversation` collection |
| Dynamic-agent checkpoint writes | Dynamic Agents | `checkpoint_writes_conversation` collection |
| Dynamic-agent file state | Dynamic Agents | GridFS |
| UI configuration and admin data | UI/BFF | Document collections |

Dynamic Agents use LangGraph's MongoDB checkpointer internally, but operators
configure it with the shared `MONGODB_URI` and `MONGODB_DATABASE` settings.

## Docker Compose

The default Compose profile includes DocumentDB. To use MongoDB with the setup
helper:

```bash
./setup-caipe.sh --docker-compose --database=mongodb
```

For a direct Compose invocation, select the DocumentDB profile and URI:

```bash
COMPOSE_PROFILES=mcp-servers,caipe-ui-prod,rbac,dynamic-agents,rag,caipe-documentdb,web_ingestor
DATABASE_PROVIDER=documentdb
MONGODB_URI=mongodb://admin:changeme@caipe-documentdb:10260/caipe?tls=true&tlsAllowInvalidCertificates=true&retryWrites=false&directConnection=true
```

The `tlsAllowInvalidCertificates` setting is limited to the bundled local image,
which generates a self-signed certificate. Use a trusted CA for external or
production DocumentDB deployments.

To explicitly use MongoDB instead:

```bash
COMPOSE_PROFILES=mcp-servers,caipe-ui-prod,rbac,dynamic-agents,rag,caipe-mongodb,web_ingestor
DATABASE_PROVIDER=mongodb
MONGODB_URI=mongodb://admin:changeme@caipe-mongodb:27017/caipe?authSource=admin
MONGODB_DATABASE=caipe
```

For local development:

```bash
COMPOSE_PROFILES=caipe-ui,dynamic-agents,caipe-documentdb docker compose -f docker-compose.dev.yaml up
```

## Helm

The umbrella chart can deploy either provider. DocumentDB is the default:

```yaml
tags:
  caipe-ui: true
  dynamic-agents: true

caipe-ui:
  mongodb:
    enabled: true

dynamic-agents:
  config:
    MONGODB_DATABASE: caipe
```

For a separate DocumentDB release, first create the shared connection Secret.
Replace the release-name placeholder if your Helm release is not `caipe`:

```bash
kubectl create secret generic caipe-documentdb-uri \
  --from-literal=MONGODB_URI='mongodb://admin:<password>@caipe-documentdb:10260/caipe?tls=true&tlsAllowInvalidCertificates=true&retryWrites=false&directConnection=true'
```

```yaml
caipe-ui:
  existingSecret: caipe-documentdb-uri
  mongodb:
    enabled: true

mongodb:
  provider: documentdb
  nameOverride: documentdb
  strictPasswords: true
  auth:
    rootUsername: admin
    rootPassword: <password>
    database: caipe

dynamic-agents:
  existingSecret: caipe-documentdb-uri
```

See `charts/ai-platform-engineering/values-documentdb.yaml.example` for the
complete DocumentDB values shape.

Existing deployments should set their provider explicitly before upgrading if
they need to remain on MongoDB; changing providers does not migrate data.

For an external MongoDB, provide the connection string through a Secret or
ExternalSecret that is mounted into both `caipe-ui` and `dynamic-agents` as
`MONGODB_URI`.

```yaml
caipe-ui:
  existingSecret: caipe-runtime-secrets

dynamic-agents:
  existingSecret: caipe-runtime-secrets
  config:
    MONGODB_DATABASE: caipe
```

### In-cluster MongoDB replica set

The bundled MongoDB chart can start one or more members with a shared keyfile
for oplog-based change capture. It does not initialize replica-set membership.
The default is a standalone MongoDB process.

1. Generate a long random keyfile in an owner-only temporary file and create
   the Secret from its **literal text**:

   ```bash
   (
     set -e
     keyfile=$(mktemp)
     trap 'rm -f "$keyfile"' EXIT
     openssl rand -base64 756 > "$keyfile"
     kubectl create secret generic <name> --from-file=keyfile="$keyfile"
   )
   ```

   `mktemp` creates the file with mode `0600`; the subshell removes it after
   the Secret is created or if the command fails. You can also use
   `stringData.keyfile` in a Secret manifest.
   Putting that text directly in `data.keyfile` makes Kubernetes decode it;
   use `data` only after encoding the entire keyfile as a Secret value.
   A secret manager and ExternalSecret can provision the same literal text
   without putting it in Helm values. All members must use the same keyfile.
2. Set `mongodb.replicaSet.enabled: true`, `mongodb.replicaSet.name`, and
   `mongodb.replicaSet.keyFileSecretName`. Set `mongodb.replicaCount` for multiple
   members; with persistence enabled, each member gets its own PVC.
3. Roll out the chart, then connect to member 0 with an authenticated `mongosh`
   session and initialize the set once:

   ```javascript
   rs.initiate({
     _id: "rs0",
     members: [{ _id: 0, host: "mongodb-0.mongodb.example.svc.cluster.local:27017" }]
   })
   ```

   Use the configured set name and a stable hostname reachable by clients and
   members. A migration service outside Kubernetes must be able to resolve and
   reach the advertised hostname. Add further members with `rs.add()` after
   they start.
4. Verify `rs.status()`, `db.hello()`, reads and writes, and oplog retention
   before starting change capture.

For multiple members, update application Secrets to use a replica-set-aware
MongoDB URI with `replicaSet=rs0` and a list of reachable member hostnames.
Remove `directConnection=true` if it was set for the standalone server, and
restart consumers to load the new URI. Every client must be able to resolve
and reach the hostnames advertised by the replica set so it can follow a new
primary after failover.

The default readiness probe checks MongoDB process reachability, not whether
membership has been initialized. A standalone-to-replica-set conversion of a
single member interrupts service during restart and until a primary is elected.
With `mongodb.persistence.enabled: false`, replacing a pod loses that member's
data and replica-set configuration; a one-member set then needs initialization
again.

For key rotation, set the single `keyfile` Secret entry to a YAML sequence
containing both the old and new keys, preserving its newlines with
`stringData.keyfile: |` or an equivalent ExternalSecret value. Replace each
secondary pod, one at a time, and then the primary pod, waiting for each member
to become healthy before continuing. Pod replacement reruns the init container
that copies the updated Secret; restarting only the `mongod` container does not.
Remove the old key from the Secret and repeat the same pod replacement order.
Members must share a key throughout. With persistence disabled, replacing a
pod loses its data and replica-set configuration. See
[MongoDB's key rotation procedure](https://www.mongodb.com/docs/manual/tutorial/rotate-key-replica-set/).

### AWS DocumentDB with External Secrets Operator

The optional `caipeDatabase` values let the parent chart manage the shared UI
ExternalSecret. They select the URI source and health-check host; they do not
deploy a database or migrate data. MongoDB remains the default backend.

```yaml
caipeDatabase:
  manageExternalSecret: true
  backend: documentdb
  secretName: caipe-runtime-secrets
  documentdb:
    remoteKey: projects/example/test/documentdb
    host: cluster.example.test

caipe-ui:
  existingSecret: caipe-runtime-secrets
  externalSecrets:
    enabled: false # The parent chart owns this ExternalSecret.
    secretStoreRef:
      name: example-store
      kind: ClusterSecretStore
    data:
      - secretKey: MONGODB_URI
        remoteRef:
          key: projects/example/test/mongodb
          property: MONGODB_URI
      # Keep the other UI Secret entries here.

dynamic-agents:
  existingSecret: caipe-runtime-secrets
```

The chart uses the configured `secretStoreRef` and preserves the URI entry's
`remoteRef.property`, so the store can be Vault, AWS Secrets Manager, or another
External Secrets Operator provider. For MongoDB, set `backend: mongodb` and keep
the existing URI key and `caipe-ui.config.MONGODB_HOST`.

For AWS DocumentDB, use a URI with verified TLS, `authSource=admin`, and
`retryWrites=false`. Distribute the required CA ConfigMap to the application
namespace and mount its `global-bundle.pem` into every consumer at the path
referenced by the URI. The chart does not create the CA ConfigMap. Restart
consumers after the shared Secret or CA bundle changes.

## Runtime Notes

- Browser chat uses persistent dynamic-agent sessions.
- `POST /invoke` is stateless by default to avoid surprise MongoDB writes.
- Set `dynamic-agents.config.INVOKE_PERSIST_HISTORY=true` only for callers that
  reuse `conversation_id` and need `/invoke` history.
- The bundled DocumentDB image is pinned to `pg17-0.113.0`; upstream warns that
  `0.114.0` closes active connections after two hours.
- Switching providers does not migrate existing data. Back up with `mongodump`,
  restore with `mongorestore`, compare collection counts and indexes, and keep
  the source volume until rollback is no longer needed.
