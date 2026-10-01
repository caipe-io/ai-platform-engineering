---
sidebar_position: 4
---

# Helm

Deploy AI Platform Engineering on any Kubernetes cluster using the official Helm chart published to GitHub Container Registry.

## Prerequisites

- [Helm 3](https://helm.sh/docs/intro/install/)
- [kubectl](https://kubernetes.io/docs/tasks/tools/) configured against your cluster
- A running cluster ([Minikube](https://minikube.sigs.k8s.io/docs/start/), Kind, EKS, GKE, AKS, etc.)

## Chart registry

The chart is published as an OCI artifact:

```
oci://ghcr.io/cnoe-io/charts/ai-platform-engineering
```

Browse available versions (stable releases only, no RCs):
👉 **[ghcr.io/cnoe-io/charts/ai-platform-engineering](https://github.com/caipe-io/ai-platform-engineering/pkgs/container/charts%2Fai-platform-engineering)**

## Chart structure

```
ai-platform-engineering/        # Parent chart
├── README.md                   # Full parameter reference
└── charts/
    ├── dynamic-agents/         # Dynamic-agent chat runtime
    │   └── README.md
    ├── mcp-server/             # Generic MCP server subchart (aliased per integration)
    │   └── README.md
    ├── caipe-ui/               # CAIPE web UI (optional)
    └── rag-stack/              # RAG pipeline (optional)
```

Full parameter tables for each chart (auto-generated — regenerate with `make docs-helm-charts`):

- [ai-platform-engineering](./helm-charts/ai-platform-engineering/) — parent chart (global values, agent selection)
- [mcp-server](./helm-charts/ai-platform-engineering/mcp-server-chart) — per-integration MCP server subchart
- [caipe-ui](./helm-charts/ai-platform-engineering/caipe-ui-chart) — UI subchart values
- [caipe-ui-mongodb](./helm-charts/ai-platform-engineering/caipe-ui-mongodb-chart) — MongoDB for UI persistence
- [dynamic-agents](./helm-charts/ai-platform-engineering/dynamic-agents-chart) — dynamic agent builder service
- [slack-bot](./helm-charts/ai-platform-engineering/slack-bot-chart) — Slack bot integration
- [rag-stack](./helm-charts/rag-stack/) — RAG knowledge base (parent chart)
- [rag-server](./helm-charts/rag-stack/rag-server-chart) — RAG server
- [rag-redis](./helm-charts/rag-stack/rag-redis-chart) — Redis for RAG vector store
- [rag-ingestors](./helm-charts/rag-stack/rag-ingestors-chart) — data ingestors
- [agent-ontology](./helm-charts/rag-stack/agent-ontology-chart) — Graph RAG ontology agent

## Step 1 — Get example values files

Pull the chart locally to access the bundled example values files:

```bash
helm pull oci://ghcr.io/cnoe-io/charts/ai-platform-engineering --version <VERSION> --untar
```

Replace `<VERSION>` with the latest stable version from the [registry page](https://github.com/caipe-io/ai-platform-engineering/pkgs/container/charts%2Fai-platform-engineering).

## Step 2 — Configure secrets

Choose one of three approaches to provide API keys and agent credentials.

### Option A — Direct values file (development)

```bash
cp ai-platform-engineering/values-secrets.yaml.example values-secrets.yaml
# Edit values-secrets.yaml with your LLM keys and agent credentials
```

> Never commit `values-secrets.yaml`.

### Option B — Existing Kubernetes Secrets

If your secrets are already in the cluster:

```yaml
# values.yaml
mcp-argocd:
  agentSecrets:
    secretName: "my-existing-secret"
```

### Option C — External Secrets Operator (recommended for production)

```bash
cp ai-platform-engineering/values-external-secrets.yaml.example values-external-secrets.yaml
# Edit to point at your Vault / AWS Secrets Manager / GCP Secret Manager store
```

## Step 3 — Choose agents

MCP integrations are enabled via Helm tags. Common profiles:

| Tag | MCP integrations included |
|---|---|
| `basic` | argocd, backstage, github |
| `complete` | broad MCP set |
| Individual | `mcp-argocd`, `mcp-github`, `mcp-jira`, `mcp-slack`, ... |

## Step 4 — Install

```bash
# Minimal chart install
helm install ai-platform-engineering \
  oci://ghcr.io/cnoe-io/charts/ai-platform-engineering \
  --version <VERSION> \
  --values values-secrets.yaml

# With basic MCP integrations
helm install ai-platform-engineering \
  oci://ghcr.io/cnoe-io/charts/ai-platform-engineering \
  --version <VERSION> \
  --values values-secrets.yaml \
  --set tags.basic=true

# With External Secrets Operator
helm install ai-platform-engineering \
  oci://ghcr.io/cnoe-io/charts/ai-platform-engineering \
  --version <VERSION> \
  --values values-external-secrets.yaml
```

## Step 5 — Verify

```bash
kubectl get pods
kubectl get services
```

Wait for pods to reach `Running` / `1/1 Ready`.

## Step 6 — Access

### Port-forward (quickest)

```bash
kubectl port-forward service/ai-platform-engineering-dynamic-agents 8001:8001
```

Then access the runtime health endpoint:

```bash
curl http://localhost:8001/health
```

### Ingress (domain access)

```bash
# Enable ingress on Minikube
minikube addons enable ingress

# Deploy with ingress
helm upgrade ai-platform-engineering \
  oci://ghcr.io/cnoe-io/charts/ai-platform-engineering \
  --version <VERSION> \
  --values values-secrets.yaml \
  --values ai-platform-engineering/values-ingress.yaml.example

# Add Minikube IP to /etc/hosts
echo "$(minikube ip) dynamic-agents.local" | sudo tee -a /etc/hosts
```

## Upgrade and uninstall

```bash
# Upgrade to a new version
helm upgrade ai-platform-engineering \
  oci://ghcr.io/cnoe-io/charts/ai-platform-engineering \
  --version <NEW_VERSION> \
  --values values-secrets.yaml

# Uninstall
helm uninstall ai-platform-engineering
```

## Prompt configuration

| Value | Description |
|---|---|
| `promptConfigType: default` | Balanced orchestrator, general use (default) |
| `promptConfigType: deep_agent` | Strict zero-hallucination mode for production |
| `promptConfig: \|` | Provide a fully custom prompt config inline |

```bash
helm install ai-platform-engineering \
  oci://ghcr.io/cnoe-io/charts/ai-platform-engineering \
  --version <VERSION> \
  --values values-secrets.yaml \
  --set promptConfigType=deep_agent
```

## Persistence

See the [Persistence](./persistence.md) page for MongoDB-backed chat and dynamic-agent runtime state.

### Quick start

```yaml
# values-persistence.yaml
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

```bash
helm install ai-platform-engineering \
  oci://ghcr.io/cnoe-io/charts/ai-platform-engineering \
  --version <VERSION> \
  --values values-secrets.yaml \
  --values values-persistence.yaml
```

Or as `--set` flags:

```bash
helm install ai-platform-engineering \
  oci://ghcr.io/cnoe-io/charts/ai-platform-engineering \
  --version <VERSION> \
  --values values-secrets.yaml \
  --set tags.caipe-ui=true \
  --set tags.dynamic-agents=true \
  --set caipe-ui.mongodb.enabled=true \
  --set dynamic-agents.config.MONGODB_DATABASE=caipe
```

## Optional components

| Component | Helm flag | Notes |
|---|---|---|
| RAG stack | `--set tags.rag-stack=true` | Milvus, Langfuse, embedding server |
| CAIPE UI | `--set tags.caipe-ui=true` | Web chat UI |
| MongoDB persistence | `--set caipe-ui.mongodb.enabled=true` | See [Persistence](./persistence.md) |
| Slack bot | `--set tags.slack-bot=true` | Slack client (not an agent) |

## Security notes

- Use Kubernetes Secrets or the External Secrets Operator for credentials — never inline plaintext in committed files.
- Rotate LLM API keys regularly.
- Use HTTPS in production (configure TLS in `ingress.tls`).
