---
sidebar_position: 1
sidebar_label: Overview
---

# Installation Overview

CAIPE ships as a set of containerized services deployable via Helm or Docker Compose.
Pick the path that matches your environment:

| Environment | Best for | Guide |
|---|---|---|
| **Docker Compose** | Local development and quick evaluation | [Docker Compose →](./docker-compose.md) |
| **KinD** | Local Kubernetes cluster (CI / laptop) | [KinD →](./kind.md) |
| **Helm (production)** | Any Kubernetes cluster — EKS, GKE, AKS, on-prem | [Helm →](./helm.md) |
| **EKS** | AWS-managed Kubernetes | [EKS →](./eks.md) |

## Prerequisites

- **LLM provider** — any OpenAI-compatible endpoint (Anthropic Claude, OpenAI, Google Vertex AI Gemini, local Ollama, LiteLLM proxy, etc.)
- **Kubernetes 1.27+** (for Helm / KinD / EKS paths) or **Docker Compose v2** (for local path)
- `kubectl`, `helm` 3.x, and optionally `kind` installed on your workstation

## What gets deployed

A full CAIPE stack includes:

- **caipe-ui** — web interface (React / Next.js)
- **MongoDB** — chat and agent-config persistence  
- **dynamic-agents** — runtime for user-built custom agents
- **MCP servers** — tool servers for ArgoCD, GitHub, Backstage, and other integrations
- **RAG stack** *(optional)* — ingestors, vector store, graph RAG server
- **Slack / Webex bots** *(optional)*

The minimal install (UI + Dynamic Agents + MongoDB) is enough to run chat with configured MCP tools.

## Quickest path

```bash
# Interactive setup script — detects Docker or Kubernetes automatically
bash <(curl -fsSL https://raw.githubusercontent.com/caipe-io/ai-platform-engineering/main/setup-caipe.sh)
```

Or via Helm directly:

```bash
helm upgrade --install ai-platform-engineering \
    oci://ghcr.io/cnoe-io/charts/ai-platform-engineering \
    --version 0.4.8 -f your-values.yaml
```

See [Getting Started → Quick Start](/docs/getting-started/quick-start) for a full walkthrough.

## Persistence

Durable chat state uses MongoDB. See the [Persistence guide](./persistence.md)
for Docker Compose, Helm, and external MongoDB configuration.

## Helm Chart Reference

The [Helm section](./helm.md) contains the full `values.yaml` reference for every
sub-chart, including agent profiles, ingress, ExternalSecrets, and LLM configuration.
Individual chart references are in the sidebar under **Chart Reference**.
