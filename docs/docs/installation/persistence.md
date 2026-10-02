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
