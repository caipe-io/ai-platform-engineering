---
sidebar_position: 2
---

# Deploy CAIPE with Helm

Use the Helm chart to run CAIPE on any Kubernetes cluster — EKS, GKE, AKS, KinD, or self-managed.

:::tip Need a cluster first?
If you don't have a Kubernetes cluster yet, see [Cluster Setup](./cluster-setup.md) for KinD (local, no cloud account needed) and AWS EKS instructions. Return here once `kubectl get nodes` shows nodes in `Ready` state.
:::

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| Kubernetes 1.28+ | [Set one up](./cluster-setup.md) if needed |
| `kubectl` | Configured against your cluster |
| Helm 3 | `helm version` to verify |
| LLM credentials | OpenAI, Azure OpenAI, or AWS Bedrock |

---

## Configure Secrets

Create the namespace and secrets before running the Helm install. The commands
below are safe to repeat.

```bash
kubectl create namespace ai-platform-engineering \
  --dry-run=client -o yaml | kubectl apply -f -
```

### LLM credentials

Pick the provider you're using:

**OpenAI**
```bash
kubectl create secret generic llm-secret \
  -n ai-platform-engineering \
  --from-literal=LLM_PROVIDER=openai \
  --from-literal=OPENAI_API_KEY=<token> \
  --from-literal=OPENAI_MODEL_NAME=gpt-4o \
  --dry-run=client -o yaml | kubectl apply -f -
```

**Azure OpenAI**
```bash
kubectl create secret generic llm-secret \
  -n ai-platform-engineering \
  --from-literal=LLM_PROVIDER=azure-openai \
  --from-literal=AZURE_OPENAI_API_KEY=<token> \
  --from-literal=AZURE_OPENAI_ENDPOINT=https://example.openai.azure.com \
  --from-literal=AZURE_OPENAI_API_VERSION=2025-03-01-preview \
  --from-literal=AZURE_OPENAI_DEPLOYMENT=gpt-4o \
  --dry-run=client -o yaml | kubectl apply -f -
```

**AWS Bedrock**
```bash
kubectl create secret generic llm-secret \
  -n ai-platform-engineering \
  --from-literal=LLM_PROVIDER=aws-bedrock \
  --from-literal=AWS_ACCESS_KEY_ID=<access-key> \
  --from-literal=AWS_SECRET_ACCESS_KEY=<secret-key> \
  --from-literal=AWS_REGION=us-east-1 \
  --from-literal=AWS_BEDROCK_MODEL_ID=us.amazon.nova-pro-v1:0 \
  --from-literal=AWS_BEDROCK_PROVIDER=amazon \
  --dry-run=client -o yaml | kubectl apply -f -
```

### MCP server credentials

Create only the secrets for MCP servers you plan to enable:

```bash
kubectl create secret generic github-secret \
  -n ai-platform-engineering \
  --from-literal=GITHUB_PERSONAL_ACCESS_TOKEN=<token> \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl create secret generic argocd-secret \
  -n ai-platform-engineering \
  --from-literal=ARGOCD_TOKEN=<token> \
  --from-literal=ARGOCD_API_URL=https://argocd.example.com \
  --from-literal=ARGOCD_VERIFY_SSL=true \
  --dry-run=client -o yaml | kubectl apply -f -
```

Dynamic Agents and the CAIPE UI both need MongoDB-compatible persistence. For
a local evaluation, enable the bundled MongoDB and provide its connection URI
through a shared Secret. Use a managed MongoDB or DocumentDB connection for
production instead of the placeholder credentials shown here.

```bash
kubectl create secret generic caipe-runtime-secret \
  -n ai-platform-engineering \
  --from-literal=MONGODB_URI='mongodb://admin:changeme@ai-platform-engineering-mongodb:27017/caipe?authSource=admin' \
  --dry-run=client -o yaml | kubectl apply -f -
```

---

## Install from OCI

The chart is published as an OCI artifact in the `caipe-io` registry. Set the
release version you want to install, then verify that it is available:

```bash
export CAIPE_CHART=oci://ghcr.io/caipe-io/charts/ai-platform-engineering
export CAIPE_VERSION=1.1.0  # replace with the release you want to install

helm show chart "${CAIPE_CHART}" --version "${CAIPE_VERSION}"
```

Minimal install — UI, Dynamic Agents, bundled MongoDB, and a starter MCP
server:

```bash
helm upgrade --install ai-platform-engineering "${CAIPE_CHART}" \
  --version "${CAIPE_VERSION}" \
  --namespace ai-platform-engineering \
  --create-namespace \
  --set-string tags.caipe-ui=true \
  --set-string tags.dynamic-agents=true \
  --set-string tags.mcp-netutils=true \
  --set-string caipe-ui.mongodb.enabled=true \
  --set-string caipe-ui.config.DYNAMIC_AGENTS_ENABLED=true \
  --set-string caipe-ui.existingSecret=caipe-runtime-secret \
  --set-string dynamic-agents.existingSecret=caipe-runtime-secret \
  --set-string dynamic-agents.llmSecret=llm-secret
```

MongoDB remains the default. For the opt-in DocumentDB values and required
shared `MONGODB_URI` Secret, see [Persistence](../../installation/persistence.md).

With GitHub, ArgoCD, and RAG:

```bash
helm upgrade --install ai-platform-engineering "${CAIPE_CHART}" \
  --version "${CAIPE_VERSION}" \
  --namespace ai-platform-engineering \
  --create-namespace \
  --set-string tags.caipe-ui=true \
  --set-string tags.dynamic-agents=true \
  --set-string tags.mcp-github=true \
  --set-string tags.mcp-argocd=true \
  --set-string tags.rag-stack=true \
  --set-string caipe-ui.mongodb.enabled=true \
  --set-string caipe-ui.config.DYNAMIC_AGENTS_ENABLED=true \
  --set-string caipe-ui.existingSecret=caipe-runtime-secret \
  --set-string dynamic-agents.existingSecret=caipe-runtime-secret \
  --set-string dynamic-agents.llmSecret=llm-secret \
  --set-string mcp-github.agentSecrets.secretName=github-secret \
  --set-string mcp-argocd.agentSecrets.secretName=argocd-secret
```

### Values file

```yaml
tags:
  caipe-ui: true
  dynamic-agents: true
  mcp-github: true
  mcp-argocd: true
  rag-stack: true

global:
  llmSecrets:
    secretName: llm-secret

caipe-ui:
  existingSecret: caipe-runtime-secret
  mongodb:
    enabled: true
  config:
    DYNAMIC_AGENTS_ENABLED: "true"
  # Optional: pre-seed model choices in the UI
  appConfig:
    models:
      - model_id: gpt-4o
        name: GPT-4o
        provider: openai
        enabled: true

dynamic-agents:
  existingSecret: caipe-runtime-secret
  llmSecret: llm-secret

mcp-github:
  agentSecrets:
    secretName: github-secret

mcp-argocd:
  agentSecrets:
    secretName: argocd-secret
```

```bash
helm upgrade --install ai-platform-engineering "${CAIPE_CHART}" \
  --version "${CAIPE_VERSION}" \
  --namespace ai-platform-engineering \
  --create-namespace \
  --values values.yaml
```

---

## Chart Components

| Component | Tag | Purpose |
|-----------|-----|---------|
| CAIPE UI | `tags.caipe-ui=true` | Web UI and BFF API |
| Dynamic Agents | `tags.dynamic-agents=true` | Chat, Agent Builder, workflows, checkpointed state |
| MCP servers | `tags.mcp-<name>=true` | Tool integrations exposed to agents |
| RAG stack | `tags.rag-stack=true` | Knowledge base and embeddings |
| Slack bot | `tags.slack-bot=true` | Slack integration |
| Webex bot | `tags.webex-bot=true` | Webex integration |

Available MCP tags: `mcp-argocd`, `mcp-aws`, `mcp-backstage`, `mcp-confluence`, `mcp-github`, `mcp-gitlab`, `mcp-jira`, `mcp-komodor`, `mcp-pagerduty`, `mcp-slack`, `mcp-splunk`, `mcp-victorops`, `mcp-webex`, `mcp-netutils`.

---

## Verify

```bash
helm list -n ai-platform-engineering
kubectl get pods -n ai-platform-engineering
kubectl logs -n ai-platform-engineering -l app.kubernetes.io/name=dynamic-agents
```

---

## Troubleshooting

- **Pods not starting**: `kubectl describe pod <pod> -n ai-platform-engineering`
- **Check rendered manifests**: `helm template ai-platform-engineering charts/ai-platform-engineering --values values.yaml`
- Ensure `tags.dynamic-agents=true` is set when Dynamic Agents should run
- MCP tag names use `mcp-*` prefix (e.g. `tags.mcp-github=true`)
